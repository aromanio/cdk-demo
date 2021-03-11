import * as aws from 'aws-sdk';
import * as lambda from 'aws-lambda';
import * as uuid from 'uuid';
import { simpleParser, ParsedMail } from 'mailparser';
import parsePdf from 'pdf-parse';

const docClient = new aws.DynamoDB.DocumentClient();
const s3Client = new aws.S3();
const sfn = new aws.StepFunctions();

enum Disposition {
    STOP_RULE_SET = 'STOP_RULE_SET',
    CONTINUE = 'CONTINUE',
}

interface RuleSetOutput {
    disposition: Disposition;
}

async function downloadEmail(notification: lambda.SESMessage): Promise<ParsedMail> {
    const Bucket = process.env.BUCKET_NAME!;
    const Key = `emails/${notification.mail.messageId}`;

    const mailBodyStream = s3Client.getObject({ Bucket, Key }).createReadStream();
    
    return await simpleParser(mailBodyStream);
}

async function dropEmail(notification: lambda.SESMessage): Promise<RuleSetOutput> {
    const Bucket = process.env.BUCKET_NAME!;
    const Key = `emails/${notification.mail.messageId}`;

    await s3Client.deleteObject({ Bucket, Key }).promise();

    return { disposition: Disposition.STOP_RULE_SET };
}

async function skipEmail(notification: lambda.SESMessage): Promise<RuleSetOutput> {
    return { disposition: Disposition.CONTINUE };
}

async function handleCodeEmail(notification: lambda.SESMessage): Promise<RuleSetOutput> {
    const email = await downloadEmail(notification);
    const [, vin, code] = (email.html as string).match(/seria de caroserie <b>(.+?)<\/b>. .+? codul <b>(\d+)<\/b>/) ?? [];

    if (!vin || !code) {
        return await skipEmail(notification);
    }

    console.log('Trying to get dynamodb object');
    const result = await docClient.get({
        TableName: process.env.TABLE_NAME!,
        Key: { pk: uuid.v5(vin, '89b3fbd4-47ad-4e85-bcdb-81bc9393aed8') },
    }).promise();

    if (!result || !result.Item || !result.Item.token) {
        return await skipEmail(notification);
    }

    console.log('Trying to send task success');
    await sfn.sendTaskSuccess({
        taskToken: result.Item.token,
        output: JSON.stringify({ vin, code }),
    }).promise();

    return await dropEmail(notification);
}

async function handleReportEmail(notification: lambda.SESMessage): Promise<RuleSetOutput> {
    const email = await downloadEmail(notification);
    const pdfAttachment = email.attachments.find(attachment => attachment.contentType === 'application/pdf');

    if (!pdfAttachment) {
        return await skipEmail(notification);
    }

    // Parse pdf and extract data
    const pdf = await parsePdf(pdfAttachment.content);
    const lines = pdf.text.split(/\n+/);
    const [, vin] = pdf.text.replace(/\s+/g, '').match(/Numaridentificare(.+?)CartedeIdentitate/) ?? [];

    if (!vin) {
        return await skipEmail(notification);
    }
    const mileageLines = lines.filter(line => /^\d+\d{2}\.\d{2}\.\d{4}(Statie ITP|RAR)$/.test(line));
    const mileage = mileageLines.map(line => line.match(/^(\d+)(\d{2})\.(\d{2})\.(\d{4})(Statie ITP|RAR)$/)!).map(([, value, day, month, year, location]) => ({
        value: Number(value),
        date: `${year}-${month}-${day}`,
        location,
    }));

    // Upload pdf attachment to S3 bucket
    const Bucket = process.env.BUCKET_NAME!;
    const Key = `reports/${notification.mail.messageId}`;
    const { Location: document } = await s3Client.upload({ Bucket, Key}).promise();

    // Update vehicle data
    const { Attributes: data } = await docClient.update({
        TableName: process.env.TABLE_NAME!,
        Key: { pk: uuid.v5(vin, '89b3fbd4-47ad-4e85-bcdb-81bc9393aed8') },
        UpdateExpression: 'set #vin = :vin, #status = :status, #mileage = :mileage, #document = :document',
        ExpressionAttributeNames: { '#status': 'status', '#mileage': 'mileage', '#document': 'document', '#vin': 'vin' },
        ExpressionAttributeValues: {
            ':status': 'READY',
            ':mileage': mileage,
            ':document': document,
            ':vin': vin,
        },
        ReturnValues: 'ALL_NEW',
    }).promise();
    
    if (data && data.token) {
        sfn.sendTaskSuccess({
            taskToken: data.token,
            output: JSON.stringify({ mileage, document }),
        });
    }

    return await dropEmail(notification);
}

export async function parseEmail(event: lambda.SESEvent) {
    const notification = event.Records[0].ses;

    if (/^Istoric vehicul cu numar de identificare .+?$/.test(notification.mail.commonHeaders.subject ?? '')) {
        return await handleCodeEmail(notification)
    } else if (/^Istoric vehicul$/.test(notification.mail.commonHeaders.subject ?? '')) {
        return await handleReportEmail(notification);
    }

    return await skipEmail(notification);
}
