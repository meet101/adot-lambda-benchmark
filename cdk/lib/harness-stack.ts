import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { BenchmarkStack } from "./benchmark-stack";

interface HarnessStackProps extends cdk.StackProps {
  benchmarkStack: BenchmarkStack;
}

export class HarnessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HarnessStackProps) {
    super(scope, id, props);

    const { benchmarkStack } = props;

    // OIDC provider for GitHub Actions — one per account.
    // If one already exists, import it instead of creating a new one.
    const githubOidc = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const harnessRole = new iam.Role(this, "HarnessRole", {
      roleName: "adot-benchmark-harness",
      assumedBy: new iam.WebIdentityPrincipal(githubOidc.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": "repo:meet101/adot-lambda-benchmark:ref:refs/heads/*",
        },
      }),
    });

    // Lambda permissions — scoped to bench-* functions only.
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunctionConfiguration",
          "lambda:InvokeFunction",
          "lambda:PublishVersion",
        ],
        resources: [`arn:aws:lambda:us-east-1:${this.account}:function:bench-*`],
      })
    );

    // CloudWatch Logs — read REPORT lines from bench-* log groups.
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:FilterLogEvents", "logs:GetLogEvents"],
        resources: [
          `arn:aws:logs:us-east-1:${this.account}:log-group:/aws/lambda/bench-*:*`,
        ],
      })
    );

    // S3 — write results JSON.
    benchmarkStack.resultsBucket.grantPut(harnessRole);

    new cdk.CfnOutput(this, "HarnessRoleArn", {
      value: harnessRole.roleArn,
    });
  }
}
