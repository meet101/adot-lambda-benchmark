# ADOT Lambda Cold Start Benchmark

Measures the cold-start latency overhead added by the [AWS Distro for OpenTelemetry (ADOT)](https://aws-otel.github.io/docs/getting-started/lambda) Lambda layer across three runtimes, seven memory sizes, and (for Python) with and without SnapStart.

**Live results → [meet101.github.io/adot-lambda-benchmark](https://meet101.github.io/adot-lambda-benchmark/)**

## What is measured

| Phase | What | Variants |
|---|---|---|
| **Phase 1** | Cold start init / restore duration | Baseline, +ADOT, SnapStart, SnapStart+ADOT |
| **Phase 2** | Steady-state per-invocation duration with live DynamoDB I/O | Baseline, +ADOT |

**Setup:** ARM64 (Graviton) · us-east-1 · 10 samples per cell per run · 5 runs total (50 samples/cell)

**Runtimes:** Node.js 24 · Python 3.13 · Rust (provided.al2023)

**Memory sizes:** 128, 256, 512, 1024, 1769, 3008, 10240 MB

## Key findings (Phase 1, p50)

| Runtime | Baseline | +ADOT | Overhead |
|---|---|---|---|
| Node.js 24 | ~137 ms | ~437 ms | +300 ms (+220%) |
| Python 3.13 | ~97 ms | ~1,250 ms | +1,153 ms (+1190%) |
| Rust | ~22 ms | ~299 ms | +277 ms (+1260%) |

> **Node.js 24 note:** The ADOT `otel-handler` exec wrapper relies on callback-based handlers removed in Node.js 24. The +ADOT variant runs the ADOT collector extension only (no SDK auto-instrumentation). Overhead shown is the collector sidecar startup cost.

> **SnapStart note:** Env-var nonce changes do not force a SnapStart restore. Expect n=1–3 cold samples per run; treat those numbers as directional.

## Repository layout

```
cdk/                    CDK TypeScript app — deploys all Lambda functions and IAM roles
  lib/benchmark-stack.ts    74 Lambda functions (56 Phase 1 + 18 Phase 2) + DynamoDB table + S3 bucket
  lib/harness-stack.ts      GitHub Actions OIDC IAM role with least-privilege permissions
handlers/
  nodejs/phase1/        No-op handler  →  export const handler = async () => ({statusCode:200})
  nodejs/phase2/        DynamoDB GetItem handler
  python/phase1/        No-op handler
  python/phase2/        DynamoDB GetItem handler
  rust/phase1/          No-op handler (cargo-lambda, ARM64)
  rust/phase2/          DynamoDB GetItem handler
harness/
  run.py                Benchmark runner — triggers cold starts, reads CloudWatch REPORT lines
scripts/
  publish_snapstart.py  Publishes Lambda versions for SnapStart functions after deploy
docs/                   GitHub Pages root
  index.html            Results site (Chart.js, no build step)
  data/phase1/          Aggregated JSON + per-run raw samples
  data/phase2/          Aggregated JSON + per-run raw samples
.github/workflows/
  benchmark.yml         Manually triggered benchmark run (workflow_dispatch)
  teardown.yml          Tears down all AWS infrastructure
```

## ADOT layer ARNs (ARM64, us-east-1)

| Runtime | Layer ARN |
|---|---|
| Python | `arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-python-arm64-ver-1-32-0:2` |
| Node.js | `arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-nodejs-arm64-ver-1-30-2:1` |
| Rust (collector) | `arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-collector-arm64-ver-0-117-0:1` |

## Running it yourself

### Prerequisites

- AWS account with CDK bootstrap (`npx cdk bootstrap`)
- Node.js 20+ and Python 3.9+
- [cargo-lambda](https://www.cargo-lambda.info/) for building Rust handlers
- GitHub repository with Actions enabled

### 1. Deploy infrastructure (one-time)

```bash
# Build Rust handlers first
cd handlers/rust
cargo lambda build --release --arm64
cd ../..

# Deploy both stacks
cd cdk
npm ci
npx cdk deploy BenchmarkStack HarnessStack
```

`cdk deploy` outputs the harness IAM role ARN. Add it as a GitHub Actions secret named `AWS_HARNESS_ROLE_ARN`.

### 2. Publish SnapStart versions

```bash
python3 scripts/publish_snapstart.py
```

This publishes Lambda versions for all Python SnapStart functions and writes `docs/data/snapstart-versions.json`.

### 3. Run the benchmark

**Via GitHub Actions (recommended):** Go to Actions → Run Benchmark → Run workflow. Repeat 5 times for full statistical confidence (50 samples/cell).

**Locally (dry-run):**

```bash
pip install -r harness/requirements.txt
python3 harness/run.py --phase 1 --smoke        # 8 cells × 2 samples, ~20 min
python3 harness/run.py --phase 1                # all 56 cells × 10 samples, ~4 hours
python3 harness/run.py --phase 2                # requires OpenObserve endpoint
```

Each run appends raw samples under `docs/data/phase1/raw/{run_id}/` and rewrites `aggregated.json` with cumulative stats across all runs.

### 4. Phase 2 (optional)

Phase 2 measures warm invocation overhead with a real OTLP backend. Run an [OpenObserve](https://openobserve.ai/) instance and pass its endpoint:

```bash
python3 harness/run.py --phase 2 --o2-endpoint http://<ec2-ip>:4317
```

Or via GitHub Actions: provide the `o2_endpoint` input when triggering the workflow.

### 5. Teardown

```bash
cd cdk && npx cdk destroy BenchmarkStack HarnessStack --force
```

Or trigger the **Teardown Infrastructure** workflow from GitHub Actions. Note: the S3 results bucket and DynamoDB table use `RemovalPolicy.RETAIN` and must be deleted manually if desired.

## How cold starts are forced

Each sample follows this sequence (design doc §5.5):

1. `UpdateFunctionConfiguration` — change `COLD_START_NONCE` env var to a unique timestamp. This forces Lambda to create a new execution environment on next invocation.
2. Poll `GetFunctionConfiguration` until `LastUpdateStatus == Successful`.
3. `Invoke` the function.
4. `FilterLogEvents` on the function's CloudWatch log group, filtering for the `REPORT RequestId:` line of this invocation. Parse `Init Duration` (or `Restore Duration` for SnapStart).

## Cost estimate

A full 5-run benchmark costs approximately **$8–12 USD** in Lambda invocation + CloudWatch + S3 costs (us-east-1, ARM64). The 10240 MB cells are the most expensive but still under $0.50 total across 5 runs.

## License

MIT
