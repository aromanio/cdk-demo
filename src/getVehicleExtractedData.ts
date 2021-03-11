import * as lambda from 'aws-lambda';
import * as aws from 'aws-sdk';
import * as uuid from 'uuid';

const docClient = new aws.DynamoDB.DocumentClient();

export async function getVehicleExtractedData(event: lambda.APIGatewayProxyEvent): Promise<lambda.APIGatewayProxyResult> {
    const { vin } = event.pathParameters!;

    const result = await docClient.get({
        TableName: process.env.TABLE_NAME!,
        Key: { pk: uuid.v5(vin!, '89b3fbd4-47ad-4e85-bcdb-81bc9393aed8') }
    }).promise();

    if (!result || !result.Item) {
        return {
            statusCode: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: 'VEHICLE_NOT_FOUND',
            }),
        };
    }

    const { status, mileage, document } = result.Item!;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            vin,
            status,
            mileage,
            document,
        }),
    };
}
