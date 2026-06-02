import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

// Jaeger v2 is a full OTel collector — receives OTLP on :4317, UI on :16686.
const JAEGER_VERSION = "2.18.0";

export class ObservabilityStack extends cdk.Stack {
  public readonly otlpEndpoint: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // VPC: autoconfig-vpc — no default VPC in this account.
    const VPC_ID    = "vpc-0fd30279f6569abd4";
    const SUBNET_ID = "subnet-077253f58b3802eed"; // us-east-1a, public

    // ── Security group ────────────────────────────────────────────────────────
    const sg = new ec2.CfnSecurityGroup(this, "ObsSG", {
      groupDescription: "ADOT benchmark observability: Jaeger + otelcol",
      vpcId: VPC_ID,
      securityGroupIngress: [
        { ipProtocol: "tcp", fromPort: 4317,  toPort: 4317,  cidrIp: "0.0.0.0/0", description: "OTLP gRPC from Lambda" },
        { ipProtocol: "tcp", fromPort: 16686, toPort: 16686, cidrIp: "0.0.0.0/0", description: "Jaeger UI" },
        { ipProtocol: "tcp", fromPort: 22,    toPort: 22,    cidrIp: "0.0.0.0/0", description: "SSH" },
      ],
    });

    // ── IAM instance profile (SSM so SSH key is optional) ────────────────────
    const role = new iam.Role(this, "ObsRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    const profile = new iam.CfnInstanceProfile(this, "ObsProfile", {
      roles: [role.roleName],
    });

    // ── User data ─────────────────────────────────────────────────────────────
    const script = [
      "#!/bin/bash",
      "set -xe",
      "exec > /var/log/userdata.log 2>&1",
      "apt-get update -y",
      "apt-get install -y curl",

      // ── Jaeger all-in-one (receives OTLP on :4317, UI on :16686) ─────────
      "mkdir -p /opt/jaeger",
      `curl -sSfL "https://github.com/jaegertracing/jaeger/releases/download/v${JAEGER_VERSION}/jaeger-${JAEGER_VERSION}-linux-amd64.tar.gz" -o /opt/jaeger/jaeger.tar.gz`,
      "tar -xzf /opt/jaeger/jaeger.tar.gz -C /opt/jaeger --strip-components=1",
      "chmod +x /opt/jaeger/jaeger",

      // Jaeger v2 uses a YAML config (OTel Collector format).
      `python3 -c "
import base64, textwrap
cfg = textwrap.dedent('''
extensions:
  jaeger_storage:
    backends:
      memstore:
        memory:
          max_traces: 100000
  jaeger_query:
    storage:
      traces: memstore
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch:
exporters:
  jaeger_storage_exporter:
    trace_storage: memstore
service:
  extensions: [jaeger_storage, jaeger_query]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger_storage_exporter]
''').strip()
open('/opt/jaeger/config.yaml','w').write(cfg)
"`,

      `cat > /etc/systemd/system/jaeger.service << 'SVCEOF'
[Unit]
Description=Jaeger all-in-one v2
After=network.target

[Service]
ExecStart=/opt/jaeger/jaeger --config=file:/opt/jaeger/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF`,

      "systemctl daemon-reload",
      "systemctl enable jaeger",
      "systemctl start jaeger",
      "echo 'USERDATA COMPLETE'",
    ].join("\n");

    const b64UserData = Buffer.from(script).toString("base64");

    // ── EC2 instance (Ubuntu 24.04 LTS, x86_64, us-east-1) ───────────────────
    const instance = new ec2.CfnInstance(this, "ObsInstance", {
      imageId: "ami-084568db4383264d4",  // Ubuntu 24.04 LTS us-east-1
      instanceType: "t3.small",
      subnetId: SUBNET_ID,
      securityGroupIds: [sg.ref],
      iamInstanceProfile: profile.ref,
      userData: b64UserData,
      tags: [{ key: "Name", value: "adot-benchmark-obs" }],
    });

    // Elastic IP for a stable address across stop/start.
    const eip = new ec2.CfnEIP(this, "ObsEIP", { instanceId: instance.ref });

    this.otlpEndpoint = `http://${eip.ref}:4317`;

    new cdk.CfnOutput(this, "OtlpEndpoint", {
      value: this.otlpEndpoint,
      description: "OTLP gRPC endpoint — pass as o2_endpoint workflow input",
    });
    new cdk.CfnOutput(this, "JaegerUI", {
      value: `http://${eip.ref}:16686`,
      description: "Jaeger UI — search traces from Lambda invocations",
    });
  }
}
