import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

// Pinned ADOT layer ARNs (ARM64, us-east-1).
// Confirm with `aws lambda list-layer-versions` before each run — see design doc §3.
const ADOT_LAYER_ARNS = {
  python: "arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-python-arm64-ver-1-32-0:2",
  nodejs: "arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-nodejs-arm64-ver-1-30-2:1",
  // Replace <version> with the confirmed integer version before deploying.
  rust: "arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-collector-arm64-ver-0-117-0:1",
} as const;

const MEMORY_SIZES = [128, 256, 512, 1024, 1769, 3008, 10240];
const PHASE2_MEMORY_SIZES = [512, 1024, 1769];

export class BenchmarkStack extends cdk.Stack {
  // S3 bucket where the harness writes raw JSON results.
  public readonly resultsBucket: s3.Bucket;
  // DynamoDB table used by Phase 2 handlers.
  public readonly phase2Table: dynamodb.Table;
  // Names of all deployed functions, for the harness manifest.
  public readonly functionNames: string[] = [];

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.resultsBucket = new s3.Bucket(this, "ResultsBucket", {
      bucketName: `adot-benchmark-results-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: false,
    });

    this.phase2Table = new dynamodb.Table(this, "Phase2Table", {
      tableName: "bench-phase2-items",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const adotPythonLayer = lambda.LayerVersion.fromLayerVersionArn(
      this, "AdotPythonLayer", ADOT_LAYER_ARNS.python
    );
    const adotNodeLayer = lambda.LayerVersion.fromLayerVersionArn(
      this, "AdotNodeLayer", ADOT_LAYER_ARNS.nodejs
    );
    const adotRustLayer = lambda.LayerVersion.fromLayerVersionArn(
      this, "AdotRustLayer", ADOT_LAYER_ARNS.rust
    );

    const phase2TableEnv = { TABLE_NAME: this.phase2Table.tableName };

    // ── Phase 1: Node.js 24 ──────────────────────────────────────────────────
    for (const memory of MEMORY_SIZES) {
      this.makeFunction("p1", "node", "baseline", memory, {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/nodejs/phase1")
        ),
        handler: "index.handler",
      });

      this.makeFunction("p1", "node", "adot", memory, {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/nodejs/phase1")
        ),
        handler: "index.handler",
        layers: [adotNodeLayer],
        environment: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-handler",
          OTEL_NODE_ENABLED_INSTRUMENTATIONS: "aws-sdk,aws-lambda,http",
        },
      });
    }

    // ── Phase 1: Python 3.13 (4 variants) ────────────────────────────────────
    for (const memory of MEMORY_SIZES) {
      this.makeFunction("p1", "python", "baseline", memory, {
        runtime: lambda.Runtime.PYTHON_3_13,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/python/phase1")
        ),
        handler: "handler.handler",
      });

      this.makeFunction("p1", "python", "adot", memory, {
        runtime: lambda.Runtime.PYTHON_3_13,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/python/phase1")
        ),
        handler: "handler.handler",
        layers: [adotPythonLayer],
        environment: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
        },
      });

      // SnapStart requires a published version — snapStart is enabled here;
      // the harness publishes a version after deploy and invokes via version ARN.
      this.makeFunction("p1", "python", "snapstart", memory, {
        runtime: lambda.Runtime.PYTHON_3_13,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/python/phase1")
        ),
        handler: "handler.handler",
        snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS,
      });

      this.makeFunction("p1", "python", "snapstart-adot", memory, {
        runtime: lambda.Runtime.PYTHON_3_13,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/python/phase1")
        ),
        handler: "handler.handler",
        layers: [adotPythonLayer],
        environment: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
        },
        snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS,
      });
    }

    // ── Phase 1: Rust on provided.al2023 ────────────────────────────────────
    for (const memory of MEMORY_SIZES) {
      this.makeFunction("p1", "rust", "baseline", memory, {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/rust/target/lambda/phase1")
        ),
        handler: "bootstrap",
      });

      // Rust +ADOT = collector extension layer only; no exec wrapper, no SDK.
      this.makeFunction("p1", "rust", "adot", memory, {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/rust/target/lambda/phase1")
        ),
        handler: "bootstrap",
        layers: [adotRustLayer],
      });
    }

    // ── Phase 2: Node.js 24 ──────────────────────────────────────────────────
    for (const memory of PHASE2_MEMORY_SIZES) {
      const p2NodeRole = this.makePhase2Role(`p2-node-${memory}`);

      const p2NodeBase = this.makeFunction("p2", "node", "baseline", memory, {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/nodejs/phase2")
        ),
        handler: "index.handler",
        environment: phase2TableEnv,
        role: p2NodeRole,
      });
      this.phase2Table.grantReadData(p2NodeBase);

      const p2NodeAdot = this.makeFunction("p2", "node", "adot", memory, {
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/nodejs/phase2")
        ),
        handler: "index.handler",
        layers: [adotNodeLayer],
        environment: {
          ...phase2TableEnv,
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-handler",
          OTEL_NODE_ENABLED_INSTRUMENTATIONS: "aws-sdk,aws-lambda,http",
          // OTEL_EXPORTER_OTLP_ENDPOINT is set at runtime via harness env update
        },
        role: p2NodeRole,
      });
      this.phase2Table.grantReadData(p2NodeAdot);
    }

    // ── Phase 2: Python 3.13 ─────────────────────────────────────────────────
    for (const memory of PHASE2_MEMORY_SIZES) {
      const p2PyRole = this.makePhase2Role(`p2-python-${memory}`);

      const p2PyBase = this.makeFunction("p2", "python", "baseline", memory, {
        runtime: lambda.Runtime.PYTHON_3_13,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/python/phase2")
        ),
        handler: "handler.handler",
        environment: phase2TableEnv,
        role: p2PyRole,
      });
      this.phase2Table.grantReadData(p2PyBase);

      const p2PyAdot = this.makeFunction("p2", "python", "adot", memory, {
        runtime: lambda.Runtime.PYTHON_3_13,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/python/phase2")
        ),
        handler: "handler.handler",
        layers: [adotPythonLayer],
        environment: {
          ...phase2TableEnv,
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
        },
        role: p2PyRole,
      });
      this.phase2Table.grantReadData(p2PyAdot);
    }

    // ── Phase 2: Rust ────────────────────────────────────────────────────────
    for (const memory of PHASE2_MEMORY_SIZES) {
      const p2RustRole = this.makePhase2Role(`p2-rust-${memory}`);

      const p2RustBase = this.makeFunction("p2", "rust", "baseline", memory, {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/rust/target/lambda/phase2")
        ),
        handler: "bootstrap",
        environment: phase2TableEnv,
        role: p2RustRole,
      });
      this.phase2Table.grantReadData(p2RustBase);

      const p2RustAdot = this.makeFunction("p2", "rust", "adot", memory, {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../handlers/rust/target/lambda/phase2")
        ),
        handler: "bootstrap",
        layers: [adotRustLayer],
        environment: phase2TableEnv,
        role: p2RustRole,
      });
      this.phase2Table.grantReadData(p2RustAdot);
    }

    new cdk.CfnOutput(this, "ResultsBucketName", {
      value: this.resultsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "Phase2TableName", {
      value: this.phase2Table.tableName,
    });
  }

  private makeFunction(
    phase: string,
    runtime: string,
    variant: string,
    memory: number,
    props: Partial<lambda.FunctionProps> & Pick<lambda.FunctionProps, "runtime" | "code" | "handler">
  ): lambda.Function {
    const name = `bench-${phase}-${runtime}-${variant}-${memory}`;
    const logGroup = new logs.LogGroup(this, `${name}-logs`, {
      logGroupName: `/aws/lambda/${name}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, name, {
      functionName: name,
      architecture: lambda.Architecture.ARM_64,
      memorySize: memory,
      timeout: cdk.Duration.seconds(30),
      logGroup,
      ...props,
    });
    this.functionNames.push(name);
    return fn;
  }

  private makePhase2Role(id: string): iam.Role {
    return new iam.Role(this, `Role-${id}`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });
  }
}
