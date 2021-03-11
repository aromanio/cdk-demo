import axios from 'axios';
import * as uuid from 'uuid';
import * as aws from 'aws-sdk';

const docClient = new aws.DynamoDB.DocumentClient();

interface Input {
    websiteUrl: string;
    websiteKey: string;
    token: string;
}

interface Output {

}

export async function startSolvingCaptcha({ token, ...event }: Input): Promise<Output> {
    const pk = uuid.v5(token, '971625f2-f608-4c3d-bce3-51f589279a8b');

    await docClient.put({
        TableName: process.env.TABLE_NAME!,
        Item: { pk, token, ttl: Math.floor(Date.now() / 1000) + 3600 },
    }).promise();

    console.log('REQUEST', event, typeof event, process.env.ANTICAPTCHA_CLIENT_KEY!, 'done', `${process.env.API_ENDPOINT}/jobs/${pk}/continue`, 'DONEDONE');
    
    await axios({
        method: 'POST',
        url: 'https://api.anti-captcha.com/createTask',
        headers: { 'Content-Type': 'application/json' },
        responseType: 'json',
        data: {
            clientKey: process.env.ANTICAPTCHA_CLIENT_KEY!,
            task: {
                type: 'RecaptchaV2TaskProxyless',
                websiteURL: event.websiteUrl,
                websiteKey: event.websiteKey,
            },
            callbackUrl: `${process.env.API_ENDPOINT}/jobs/${pk}/continue`,
        },
    });

    return {};
}
