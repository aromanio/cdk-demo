import * as lambda from 'aws-lambda';
import * as aws from 'aws-sdk';

const sfn = new aws.StepFunctions();
const docClient = new aws.DynamoDB.DocumentClient();

export async function receiveCaptchaResult(event: lambda.APIGatewayProxyEvent): Promise<lambda.APIGatewayProxyResult> {
    const { token = '' } = event.pathParameters ?? {};

    const itemResult = await docClient.get({
        TableName: process.env.TABLE_NAME!,
        Key: { pk: token },
    }).promise();

    if (!itemResult || !itemResult.Item || !itemResult.Item.token) {
        return { statusCode: 200, body: 'OK' };
    }

    const taskToken = itemResult.Item.token;

    console.log('TOKEN', token, 'TASKTOKEN', taskToken, 'DONE');

    let result = null;
    try {
        result = JSON.parse(event.body ?? '{}') ?? {};
    } catch (error) {
        await sfn.sendTaskFailure({
            taskToken,
            error: 'InvalidCaptchaError'
        }).promise();

        return { statusCode: 200, body: 'OK' };
    }

    const { errorId, solution } = result;
    const { gRecaptchaResponse: captcha } = solution ?? {};

    if (errorId > 0 || !captcha) {
        await sfn.sendTaskFailure({
            taskToken,
            error: 'InvalidCaptchaError'
        }).promise();
    } else {
        await sfn.sendTaskSuccess({
            taskToken,
            output: JSON.stringify({ captcha }),
        }).promise();
    }

    return { statusCode: 200, body: 'OK' };
}
