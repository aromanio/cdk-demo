import * as cdk from '@aws-cdk/core';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as kms from '@aws-cdk/aws-kms';
import * as apig from '@aws-cdk/aws-apigateway';
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as ses from '@aws-cdk/aws-ses';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as r53 from '@aws-cdk/aws-route53';
import * as targets from '@aws-cdk/aws-route53-targets';
import * as actions from '@aws-cdk/aws-ses-actions';
import { DnsValidatedDomainIdentity } from 'aws-cdk-ses-domain-identity';
import * as path from 'path';

interface DemoCdkStackProps extends cdk.StackProps {
    antiCaptchaKey: string;
    emailAddress: string;
    personalEmailAddress: string;
    rootDomain: string;
    subdomain: string;
}

export class DemoCdkStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: DemoCdkStackProps) {
        super(scope, id, props);

        // DNS
        const zone = r53.HostedZone.fromLookup(this, 'Root domain hosted zone', { domainName: props.rootDomain });
        const validation = acm.CertificateValidation.fromDns(zone);
        const certificate = new acm.Certificate(this, 'Subdomain certificate', { domainName: props.subdomain, validation });
        const domain = new DnsValidatedDomainIdentity(this, 'Mail receiving domain', { domainName: props.subdomain, hostedZone: zone });

        // TABLE, BUCKET AND ENCRYPTION
        const extractedDataEncryptionKey = new kms.Key(this, 'Encryption key for extracted data');
        const historyReportsEncryptionKey = new kms.Key(this, 'Encryption key for history reports');

        const table = new ddb.Table(this, 'Table for vehicle data', {
            partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
            encryption: ddb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: extractedDataEncryptionKey,
            billingMode: ddb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
        });

        const bucket = new s3.Bucket(this, 'Bucket for history reports', {
            // encryption: s3.BucketEncryption.KMS,
            // encryptionKey: historyReportsEncryptionKey,
        });

        // STATE MACHINE
        const requestVehicleHistoryFunction = new lambda.NodejsFunction(this, 'Request vehicle history function', {
            handler: 'requestVehicleHistory',
            entry: path.join(__dirname, '..', 'src', 'requestVehicleHistory.ts'),
            environment: { PERSONAL_EMAIL_ADDRESS: props.personalEmailAddress, TABLE_NAME: table.tableName },
            timeout: cdk.Duration.minutes(2),
        });

        const startSolvingCaptchaFunction = new lambda.NodejsFunction(this, 'Start solving captcha function', {
            handler: 'startSolvingCaptcha',
            entry: path.join(__dirname, '..', 'src', 'startSolvingCaptcha.ts'),
            environment: { API_ENDPOINT: `https://${props.subdomain}`, ANTICAPTCHA_CLIENT_KEY: props.antiCaptchaKey, TABLE_NAME: table.tableName },
            timeout: cdk.Duration.minutes(2),
        });

        const submitAndProcessDataFunction = new lambda.NodejsFunction(this, 'Submit and process data function', {
            handler: 'submitAndProcessData',
            entry: path.join(__dirname, '..', 'src', 'submitAndProcessData.ts'),
            timeout: cdk.Duration.minutes(2),
            environment: { TABLE_NAME: table.tableName },
        });

        const definition = sfn.Chain
            .start(new tasks.LambdaInvoke(this, 'Request vehicle history step', {
                lambdaFunction: requestVehicleHistoryFunction,
                timeout: cdk.Duration.minutes(10),
                payload: sfn.TaskInput.fromObject({
                    vin: sfn.JsonPath.stringAt('$.vin'),
                    token: sfn.JsonPath.taskToken,
                }),
                resultPath: '$.email',
                integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
            }))
            .next(
                new sfn.Parallel(this, 'Solve captcha step', { outputPath: '$[0]' })
                    .branch(
                        sfn.Chain
                            .start(new tasks.LambdaInvoke(this, 'Start solving captcha step', {
                                lambdaFunction: startSolvingCaptchaFunction,
                                timeout: cdk.Duration.minutes(10),
                                payload: sfn.TaskInput.fromObject({
                                    websiteUrl: 'https://pro.rarom.ro/istoric_vehicul/dosar_vehicul.aspx?from=fillForm',
                                    websiteKey: '6LfQgxsUAAAAAKEq_NcUfhu_PE4sGSu0vW4-xjjR',
                                    token: sfn.JsonPath.taskToken,
                                }),
                                resultPath: '$.solve',
                                integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
                            }))
                            .next(new tasks.LambdaInvoke(this, 'Submit and process data step', {
                                lambdaFunction: submitAndProcessDataFunction,
                                payload: sfn.TaskInput.fromObject({
                                    vin: sfn.JsonPath.stringAt('$.vin'),
                                    captcha: sfn.JsonPath.stringAt('$.solve.captcha'),
                                    code: sfn.JsonPath.stringAt('$.email.code'),
                                    token: sfn.JsonPath.taskToken,
                                }),
                                timeout: cdk.Duration.minutes(10),
                                integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
                            }))
                    )
                    .addRetry({ errors: ['InvalidCaptchaError', 'States.Timeout'], maxAttempts: 5 })
                    .addCatch(new sfn.Fail(this, 'Solving captcha failed step', { cause: 'cannotSolveCaptcha' }), { errors: ['InvalidCaptchaError', 'captchaExpired'] })
            )
            .next(new sfn.Succeed(this, 'Done step'));

        const stateMachine = new sfn.StateMachine(this, 'Vehicle history state machine', { definition });

        // EMAIL RECEIVER
        const parseEmailFunction = new lambda.NodejsFunction(this, 'Parse email function', {
            handler: 'parseEmail',
            entry: path.join(__dirname, '..', 'src', 'parseEmail.ts'),
            environment: { TABLE_NAME: table.tableName, BUCKET_NAME: bucket.bucketName },
        });

        const emailReceiver = new ses.ReceiptRuleSet(this, 'Email receiver');
        emailReceiver.addRule('Parse emails from vehicle reporting service', {
            receiptRuleName: 'RAROM',
            enabled: true,
            recipients: [props.emailAddress],
            actions: [
                new actions.S3({ bucket, objectKeyPrefix: 'emails/' }),
                new actions.Lambda({ function: parseEmailFunction, invocationType: actions.LambdaInvocationType.REQUEST_RESPONSE }),
            ],
        });

        // API
        const createVehicleFunction = new lambda.NodejsFunction(this, 'Create vehicle function', {
            handler: 'createVehicle',
            entry: path.join(__dirname, '..', 'src', 'createVehicle.ts'),
            environment: { TABLE_NAME: table.tableName, STATE_MACHINE_ARN: stateMachine.stateMachineArn },
        });

        const getVehicleExtractedDataFunction = new lambda.NodejsFunction(this, 'Get vehicle extracted data function', {
            handler: 'getVehicleExtractedData',
            entry: path.join(__dirname, '..', 'src', 'getVehicleExtractedData.ts'),
            environment: { TABLE_NAME: table.tableName },
        });

        const receiveCaptchaResultFunction = new lambda.NodejsFunction(this, 'Receive captcha result function', {
            handler: 'receiveCaptchaResult',
            entry: path.join(__dirname, '..', 'src', 'receiveCaptchaResult.ts'),
            environment: { TABLE_NAME: table.tableName, STATE_MACHINE_ARN: stateMachine.stateMachineArn },
        });

        const api = new apig.RestApi(this, 'HTTP Service', { domainName: { certificate, domainName: props.subdomain } });
        api.root.addResource('jobs').addResource('{token}').addResource('continue').addMethod('POST', new apig.LambdaIntegration(receiveCaptchaResultFunction, { proxy: true }));
        const vehicles = api.root.addResource('vehicles');
        const vehicle = vehicles.addResource('{vin}');

        vehicle.addMethod('GET', new apig.LambdaIntegration(getVehicleExtractedDataFunction, { proxy: true }));
        vehicles.addMethod('POST', new apig.LambdaIntegration(createVehicleFunction, { proxy: true }));

        // PERMISSIONS
        const keyPermission = new iam.PolicyStatement();
        const tablePermissions = new iam.PolicyStatement();
        const bucketPermissions = new iam.PolicyStatement();
        const sfnPermissions = new iam.PolicyStatement();

        keyPermission.addResources(extractedDataEncryptionKey.keyArn, historyReportsEncryptionKey.keyArn);
        keyPermission.addActions('kms:Decrypt', 'kms:Encrypt');

        tablePermissions.addResources(table.tableArn);
        tablePermissions.addActions('dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem');

        bucketPermissions.addResources(`${bucket.bucketArn}/*`);
        bucketPermissions.addActions('s3:GetObject', 's3:PutObject');

        sfnPermissions.addResources(stateMachine.stateMachineArn);
        sfnPermissions.addActions('states:StartExecution', 'states:SendTaskSuccess', 'states:SendTaskFailure');

        requestVehicleHistoryFunction.addToRolePolicy(tablePermissions);
        requestVehicleHistoryFunction.addToRolePolicy(keyPermission);
      
        parseEmailFunction.addToRolePolicy(bucketPermissions);
        parseEmailFunction.addToRolePolicy(tablePermissions);
        parseEmailFunction.addToRolePolicy(keyPermission);
        parseEmailFunction.addToRolePolicy(sfnPermissions);
      
        createVehicleFunction.addToRolePolicy(tablePermissions);
        createVehicleFunction.addToRolePolicy(keyPermission);
        createVehicleFunction.addToRolePolicy(sfnPermissions);
      
        getVehicleExtractedDataFunction.addToRolePolicy(tablePermissions);
        getVehicleExtractedDataFunction.addToRolePolicy(keyPermission);
      
        startSolvingCaptchaFunction.addToRolePolicy(tablePermissions);
        startSolvingCaptchaFunction.addToRolePolicy(keyPermission);

        receiveCaptchaResultFunction.addToRolePolicy(tablePermissions);
        receiveCaptchaResultFunction.addToRolePolicy(keyPermission);
        receiveCaptchaResultFunction.addToRolePolicy(sfnPermissions);

        const bucketPolicy = bucket.node.findChild('Policy').node.findChild('Resource') as s3.CfnBucketPolicy;
        emailReceiver.node.addDependency(bucketPolicy);

        const target = new targets.ApiGateway(api);
        new r53.RecordSet(this, 'Subdomain record', {
            recordName: props.subdomain,
            recordType: r53.RecordType.A,
            target: r53.RecordTarget.fromAlias(target),
            zone,
        });
    }
}
