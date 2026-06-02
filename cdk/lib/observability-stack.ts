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

    // ── Networking ────────────────────────────────────────────────────────────
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const sg = new ec2.SecurityGroup(this, "ObsSG", {
      vpc,
      description: "ADOT benchmark observability — OpenObserve + otelcol",
      allowAllOutbound: true,
    });
    // Allow OTLP gRPC from Lambda (public internet) and SSH from anywhere.
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(4317), "OTLP gRPC from Lambda");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5080), "OpenObserve UI");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22),   "SSH");

    // ── IAM role (SSM access so SSH key is optional) ──────────────────────────
    const role = new iam.Role(this, "ObsRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // ── User data: install OpenObserve + otelcol-contrib ─────────────────────
    const b64Auth = Buffer.from(`${OO_ADMIN_EMAIL}:${OO_ADMIN_PASSWORD}`).toString("base64");

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -e",
      "apt-get update -y",
      "apt-get install -y curl wget unzip",

      // ── OpenObserve ──────────────────────────────────────────────────────
      "mkdir -p /opt/openobserve",
      "cd /opt/openobserve",
      `curl -sSfL https://github.com/openobserve/openobserve/releases/latest/download/openobserve-v$(curl -s https://api.github.com/repos/openobserve/openobserve/releases/latest | grep tag_name | cut -d'\"' -f4 | sed 's/v//')-linux-amd64.tar.gz -o openobserve.tar.gz`,
      "tar -xzf openobserve.tar.gz",
      "chmod +x openobserve",

      // OpenObserve systemd service
      `cat > /etc/systemd/system/openobserve.service << 'SVCEOF'
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
SVCEOF`,

      // ── otelcol-contrib ──────────────────────────────────────────────────
      "mkdir -p /opt/otelcol",
      "cd /opt/otelcol",
      `curl -sSfL https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_amd64.tar.gz -o otelcol.tar.gz`,
      "tar -xzf otelcol.tar.gz",
      "chmod +x otelcol-contrib",

      // otelcol config: receive OTLP gRPC on :4317, forward to OpenObserve HTTP
      `cat > /opt/otelcol/config.yaml << 'CFGEOF'
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
CFGEOF`,

      // otelcol systemd service
      `cat > /etc/systemd/system/otelcol.service << 'SVCEOF'
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
SVCEOF`,

      // Start both services
      "systemctl daemon-reload",
      "systemctl enable openobserve otelcol",
      "systemctl start openobserve",
      "sleep 5",   // let OpenObserve initialise before otelcol connects
      "systemctl start otelcol",
    );

    // ── EC2 instance (x86_64, Ubuntu 24.04 LTS) ───────────────────────────────
    const instance = new ec2.Instance(this, "ObsInstance", {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
      ),
      securityGroup: sg,
      role,
      userData,
      userDataCausesReplacement: true,
    });

    // Elastic IP so the address survives stop/start.
    const eip = new ec2.CfnEIP(this, "ObsEIP", { instanceId: instance.instanceId });

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
