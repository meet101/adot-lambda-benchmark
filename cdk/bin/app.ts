#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BenchmarkStack } from "../lib/benchmark-stack";
import { HarnessStack } from "../lib/harness-stack";

const app = new cdk.App();

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" };

const benchmark = new BenchmarkStack(app, "BenchmarkStack", { env });
new HarnessStack(app, "HarnessStack", { env, benchmarkStack: benchmark });
