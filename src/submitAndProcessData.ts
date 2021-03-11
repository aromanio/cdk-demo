import axios from 'axios';
import * as qs from 'qs';
import *  as aws from 'aws-sdk';
import * as uuid from 'uuid';

const docClient = new aws.DynamoDB.DocumentClient();

class InvalidCodeError extends Error {
    public readonly name = 'InvalidCodeError';
}

class InvalidCaptchaError extends Error {
    public readonly name = 'InvalidCaptchaError';
}

interface Input {
    vin: string;
    captcha: string;
    code: string;
    token: string;
}

interface Output {}

export async function submitAndProcessData({ vin, code, captcha, token }: Input): Promise<Output> {
    const result = await axios({
        method: 'POST',
        url: 'https://pro.rarom.ro/istoric_vehicul/dosar_vehicul.aspx?from=confirmCode',
        data: qs.stringify({
            inputCode: code,
            'g-recaptcha-response': captcha,
            inputJob: 'confirmCode',
        }),
        responseType: 'text',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const [, commandNumber] = result.data.match(/action="download.aspx\?comanda=(.+?)"/) ?? [];
    const [, failedReason] = result.data.match(/<p id="msg">(Codul de validare NU EXISTĂ, a EXPIRAT sau a fost deja FOLOSIT!)<\/p>/) ?? [];

    if (failedReason) {
        throw new InvalidCodeError(failedReason)
    } else if (!commandNumber) {
        throw new InvalidCaptchaError('Possibly invalid or expired captcha code.');
    }

    await docClient.update({
        TableName: process.env.TABLE_NAME!,
        Key: { pk: uuid.v5(vin, '89b3fbd4-47ad-4e85-bcdb-81bc9393aed8') },
        UpdateExpression: 'set #token = :token, #vin = :vin, #status = :status',
        ExpressionAttributeNames: { '#token': 'token', '#vin': 'vin', '#status': 'status' },
        ExpressionAttributeValues: { ':token': token, ':vin': vin, ':status': 'PROCESSING' },
    }).promise();

    return {};
}