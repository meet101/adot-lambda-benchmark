import boto3
import os

_client = boto3.client("dynamodb")


def handler(event, context):
    resp = _client.get_item(
        TableName=os.environ["TABLE_NAME"],
        Key={"pk": {"S": "test"}},
    )
    return resp.get("Item")
