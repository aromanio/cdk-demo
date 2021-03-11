import * as aws from 'aws-sdk';
import * as lambda from 'aws-lambda';
import * as uuid from 'uuid';

const docClient = new aws.DynamoDB.DocumentClient();
const sfn = new aws.StepFunctions();

export async function createVehicle(event: lambda.APIGatewayProxyEvent): Promise<lambda.APIGatewayProxyResult> {
    const { vin } = JSON.parse(event.body!);

    try {
        await docClient.update({
            TableName: process.env.TABLE_NAME!,
            Key: { pk: uuid.v5(vin, '89b3fbd4-47ad-4e85-bcdb-81bc9393aed8') },
            UpdateExpression: 'set #vin = :vin, #status = :status',
            ConditionExpression: '#status <> :status',
            ExpressionAttributeNames: { ':#vin': 'vin', '#status': 'status' },
            ExpressionAttributeValues: { ':vin': vin, ':status': 'PROCESSING' },
        }).promise();
    } catch (error) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vin,
                status: 'PROCESSING',
            }),
        };
    }

    await sfn.startExecution({
        stateMachineArn: process.env.STATE_MACHINE_ARN!,
        input: JSON.stringify({ vin }),
    }).promise();

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            vin,
            status: 'PROCESSING',
        }),
    };
}
