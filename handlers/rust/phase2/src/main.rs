use aws_sdk_dynamodb::types::AttributeValue;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::{json, Value};
use std::env;

async fn handler(
    _event: LambdaEvent<Value>,
    dynamo: &aws_sdk_dynamodb::Client,
    table_name: &str,
) -> Result<Value, Error> {
    let resp = dynamo
        .get_item()
        .table_name(table_name)
        .key("pk", AttributeValue::S("test".to_string()))
        .send()
        .await?;

    let item = resp.item().map(|m| {
        m.iter()
            .map(|(k, v)| (k.clone(), format!("{v:?}")))
            .collect::<std::collections::HashMap<_, _>>()
    });

    Ok(json!(item))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::load_from_env().await;
    let dynamo = aws_sdk_dynamodb::Client::new(&config);
    let table_name = env::var("TABLE_NAME").expect("TABLE_NAME must be set");

    run(service_fn(|event| handler(event, &dynamo, &table_name))).await
}
