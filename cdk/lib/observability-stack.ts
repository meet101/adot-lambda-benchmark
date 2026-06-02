import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

// OpenObserve credentials — change password before deploying to a shared account.
const OO_ADMIN_EMAIL    = "admin@example.com";
const OO_ADMIN_PASSWORD = "BenchmarkPass123!";

// otelcol-contrib version to install.
const OTELCOL_VERSION = "0.117.0";

export class ObservabilityStack extends cdk.Stack {
  public readonly otlpEndpoint: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // VPC: autoconfig-vpc (vpc-0fd30279f6569abd4) — no default VPC in this account.
    const VPC_ID    = "vpc-0fd30279f6569abd4";
    const SUBNET_ID = "subnet-077253f58b3802eed"; // us-east-1a, public

    // ── Security group ────────────────────────────────────────────────────────
    const sg = new ec2.CfnSecurityGroup(this, "ObsSG", {
      groupDescription: "ADOT benchmark observability: OpenObserve + otelcol",
      vpcId: VPC_ID,
      securityGroupIngress: [
        { ipProtocol: "tcp", fromPort: 4317, toPort: 4317, cidrIp: "0.0.0.0/0", description: "OTLP gRPC from Lambda" },
        { ipProtocol: "tcp", fromPort: 5080, toPort: 5080, cidrIp: "0.0.0.0/0", description: "OpenObserve UI" },
        { ipProtocol: "tcp", fromPort: 22,   toPort: 22,   cidrIp: "0.0.0.0/0", description: "SSH" },
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
    const b64Auth = Buffer.from(`${OO_ADMIN_EMAIL}:${OO_ADMIN_PASSWORD}`).toString("base64");

    const script = [
      "#!/bin/bash",
      "set -e",
      "apt-get update -y",
      "apt-get install -y curl wget",

      // ── OpenObserve ──────────────────────────────────────────────────────
      "mkdir -p /opt/openobserve",
      "cd /opt/openobserve",
      `OO_VER=$(curl -s https://api.github.com/repos/openobserve/openobserve/releases/latest | grep tag_name | cut -d'"' -f4 | sed 's/v//')`,
      `curl -sSfL "https://github.com/openobserve/openobserve/releases/latest/download/openobserve-v\${OO_VER}-linux-amd64.tar.gz" -o openobserve.tar.gz`,
      "tar -xzf openobserve.tar.gz",
      "chmod +x openobserve",

      `cat > /etc/systemd/system/openobserve.service << 'EOF'
[Unit]
Description=OpenObserve
After=network.target

[Service]
Environment="ZO_ROOT_USER_EMAIL=${OO_ADMIN_EMAIL}"
Environment="ZO_ROOT_USER_PASSWORD=${OO_ADMIN_PASSWORD}"
Environment="ZO_DATA_DIR=/opt/openobserve/data"
WorkingDirectory=/opt/openobserve
ExecStart=/opt/openobserve/openobserve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF`,

      // ── otelcol-contrib ──────────────────────────────────────────────────
      "mkdir -p /opt/otelcol",
      "cd /opt/otelcol",
      `curl -sSfL "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_amd64.tar.gz" -o otelcol.tar.gz`,
      "tar -xzf otelcol.tar.gz",
      "chmod +x otelcol-contrib",

      `cat > /opt/otelcol/config.yaml << 'EOF'
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s

exporters:
  otlphttp/openobserve:
    endpoint: http://localhost:5080/api/default
    headers:
      Authorization: "Basic ${b64Auth}"
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/openobserve]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/openobserve]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/openobserve]
EOF`,

      `cat > /etc/systemd/system/otelcol.service << 'EOF'
[Unit]
Description=OpenTelemetry Collector
After=network.target openobserve.service

[Service]
WorkingDirectory=/opt/otelcol
ExecStart=/opt/otelcol/otelcol-contrib --config /opt/otelcol/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF`,

      "systemctl daemon-reload",
      "systemctl enable openobserve otelcol",
      "systemctl start openobserve",
      "sleep 5",
      "systemctl start otelcol",
    ].join("\n");

    const b64UserData = Buffer.from(script).toString("base64");

    // ── EC2 instance (Ubuntu 24.04 LTS, x86_64, us-east-1) ───────────────────
    // AMI ID for Ubuntu 24.04 LTS HVM SSD in us-east-1 — update if needed.
    const instance = new ec2.CfnInstance(this, "ObsInstance", {
      imageId: "ami-084568db4383264d4",   // Ubuntu 24.04 LTS us-east-1 (2025-01)
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
    new cdk.CfnOutput(this, "OpenObserveUI", {
      value: `http://${eip.ref}:5080`,
      description: `OpenObserve UI — login: ${OO_ADMIN_EMAIL} / ${OO_ADMIN_PASSWORD}`,
    });
  }
}
