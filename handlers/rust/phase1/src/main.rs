use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::{json, Value};

async fn handler(_event: LambdaEvent<Value>) -> Result<Value, Error> {
    Ok(json!({"statusCode": 200}))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(service_fn(handler)).await
}
