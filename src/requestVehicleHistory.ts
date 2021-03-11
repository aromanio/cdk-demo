import axios from 'axios';
import * as qs from 'qs';
import * as aws from 'aws-sdk';
import * as uuid from 'uuid';

const docClient = new aws.DynamoDB.DocumentClient();

export interface Input {
    vin: string;
    token: string;
}

export interface Output {}

export async function requestVehicleHistory({ vin, token }: Input): Promise<Output> {
    const pk = uuid.v5(vin, '89b3fbd4-47ad-4e85-bcdb-81bc9393aed8');

    await docClient.update({
        TableName: process.env.TABLE_NAME!,
        Key: { pk },
        UpdateExpression: 'set #vin, #status, #token = :token',
        ExpressionAttributeNames: { '#token': 'token', '#vin': 'vin', '#status': 'status' },
        ExpressionAttributeValues: { ':token': token, ':vin': vin, ':status': 'PROCESSING' },
    }).promise();

    await axios({
        method: 'POST',
        url: 'https://pro.rarom.ro/istoric_vehicul/dosar_vehicul.aspx?from=fillForm',
        data: qs.stringify({
            inputEmail: process.env.PERSONAL_EMAIL_ADDRESS!,
            inputEmail2: process.env.PERSONAL_EMAIL_ADDRESS!,
            inputVIN: vin,
            inputTC: 'on',
            inputJob: 'fillForm',
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'text',
    });
    
    return {};
}
