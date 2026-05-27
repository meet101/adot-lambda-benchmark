# ADOT Lambda Cold Start Benchmark — Design Document

**Status:** Draft for review
**Author:** Meet
**Last updated:** 2026-05-26
**Scope:** Lambda only (ECS phase is a separate follow-on document)

---

## 1. Context and goal

We are evaluating OpenObserve as our observability backend. To do that, we need to decide how to get traces, metrics, and logs out of Lambda into OpenObserve. The two realistic options are (a) attach the AWS Distro for OpenTelemetry (ADOT) Lambda layer to functions and have it export OTLP directly, or (b) skip the layer and pipe Lambda's existing CloudWatch logs into OpenObserve.

The cost of option (a) is unknown for our runtimes at our memory configurations. ADOT loads as a Lambda extension at init time, and for Node and Python it also performs auto-instrumentation patching during runtime startup. Both add cold start latency. Published cold start benchmarks (notably [lambda-perf](https://maxday.github.io/lambda-perf/)) cover stock runtimes but do not include ADOT. The goal of this work is to produce that data.

The benchmark answers one question: **how much cold start latency does the ADOT layer add to Node.js, Python, and Rust Lambda functions on ARM64 across the full memory range?** A secondary, smaller benchmark answers: **how much per-invocation latency does ADOT auto-instrumentation add in steady state when the function does real work?**

The benchmark does not, by itself, decide which option we pick. It produces the numbers we need to make that decision.

---

## 2. Scope

In scope:

- AWS Lambda only. ECS benchmarking is a separate effort, scheduled after this one lands.
- ARM64 (Graviton) only. Per the original brief.
- Three runtimes: Node.js, Python, Rust.
- Cold start init duration (Phase 1) and steady-state per-invocation duration (Phase 2).
- A published results page so the data is shareable and re-runnable.

Explicitly out of scope:

- x86_64 architecture.
- SnapStart for Node.js and Rust. SnapStart only applies to Java and Python managed runtimes; those two runtimes are excluded here.
- Provisioned Concurrency. By definition eliminates cold starts, so not applicable to the question.
- Lambda container images. We use zip packages throughout to hold package format constant; container image cold starts are a separate axis.
- Lambda@Edge.
- Lambda Managed Instances.
- Other ADOT-supported languages (Java, .NET, Go). Add later if the Node/Python/Rust results suggest the question generalizes.
- A direct comparison with X-Ray, Datadog, New Relic, or other observability layers.

---

## 3. Test matrix

The Phase 1 matrix has three runtimes across a combined total of six variant columns and seven memory sizes — 56 cells total. Python has four variants (adding SnapStart and SnapStart+ADOT columns); Node.js and Rust have two each. The full memory sweep matches lambda-perf and gives us the shape of the curve, including the 1769 MB transition where Lambda first allocates a full vCPU (per AWS Lambda function memory documentation).

| Runtime | Managed runtime identifier | Variants | Memory sizes (MB) |
|---|---|---|---|
| Node.js | `nodejs24.x` | baseline, +ADOT layer | 128, 256, 512, 1024, 1769, 3008, 10240 |
| Python | `python3.13` | baseline, +ADOT layer, SnapStart, SnapStart+ADOT layer | 128, 256, 512, 1024, 1769, 3008, 10240 |
| Rust | `provided.al2023` | baseline, +ADOT collector-extension only | 128, 256, 512, 1024, 1769, 3008, 10240 |

Runtime version selection rationale, with the verified constraints:

- **Node.js 24.x.** The ADOT JavaScript Lambda layer documentation states support for "Node.JS v18+", so 20.x, 22.x, and 24.x are all compatible. We pick 24 as the current active-development line. Node.js 24 became the Current release in April 2025 and will enter LTS in October 2025; using it means our results reflect the version new projects will target.
- **Python 3.13.** The ADOT Python Lambda layer documentation explicitly lists Python 3.8 through 3.13 as supported. Lambda's managed Python runtime list now includes 3.14, but **ADOT has no layer for 3.14 yet** — using 3.14 would mean no "+ADOT" variant exists, which breaks the comparison. 3.13 is the latest version we can test on both sides. Python 3.13 also supports SnapStart (SnapStart is available for Python 3.12+ on ARM64), which enables the SnapStart variant columns.
- **Rust on provided.al2023.** Rust does not have a managed runtime. Lambda Rust support went GA on 2025-11-14 via the `aws-lambda-rust-runtime` library on the `provided.al2023` custom runtime. We compile the binary with `cargo lambda` and ship it as a zip.

The Rust "+ADOT" variant attaches the standalone collector layer (`aws-otel-collector-arm64-ver-0-117-0`) — there is no auto-instrumentation for Rust in ADOT, so this variant measures the cost of the collector extension process spawning at init, nothing more. We will be explicit in the results writeup that this is not the same thing as the Node/Python "+ADOT" variant, which includes both the extension and auto-instrumentation patching.

### ADOT layer ARNs (pinned)

We pin specific layer versions for reproducibility. Every result published carries the layer ARN it was measured against. The currently published ADOT Lambda layer ARNs (ARM64, us-east-1) are:

```
Python: arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-python-arm64-ver-1-32-0:2
Node:   arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-nodejs-arm64-ver-1-30-2:1
Rust:   arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-collector-arm64-ver-0-117-0:<version>
```

Contents per the ADOT release notes as published: Python layer bundles OpenTelemetry Python 1.32.0 plus ADOT Collector for Lambda 0.43.0. Node layer bundles OpenTelemetry JavaScript Core 1.30.0 plus AWS Lambda Instrumentation 0.50.3 plus ADOT Collector 0.43.0. Collector-only layer bundles ADOT Collector 0.43.0.

Caveat: the ADOT documentation page and the `aws-otel-lambda` GitHub README list slightly different version strings for the Node layer (the docs table shows `ver-1-30-2:1`, the README shows `ver-1-30-0`). All three layer ARNs (and the trailing `:<layer-version>` integer for each) must be confirmed against `aws lambda list-layer-versions` at deploy time and recorded in the published results. We do not assume the strings above are still current at run time — they are correct as of the writing of this doc.

### Open variables not yet decided

- Region. Recommend **us-east-1** because it is in the published ADOT support list and has the largest pool of EC2/Lambda capacity, which means less variance from underlying host churn. Also lowest pricing tier; pricing differences across regions are small but consistent.
- Number of cold samples per cell per run. Recommend **10**, matching lambda-perf.
- Number of repeated runs spread over time. Recommend **5 runs over 48 hours**, varying the time of day, to smooth out AWS host-level variance. Total samples per cell = 50.

---

## 4. Methodology

### 4.1 Forcing cold starts

A cold start happens when Lambda creates a new execution environment, which happens when (a) the function is invoked for the first time, (b) all warm environments have been recycled, or (c) the function's configuration has changed since the last invocation. Option (c) is the reliable trigger. Lambda invalidates execution environments when function code or configuration is updated.

Two trigger options:

1. **Update an environment variable and invoke.** Each invocation in the sample set first issues `UpdateFunctionConfiguration` with a changed env var (e.g., a counter), waits for the update to propagate, then issues `Invoke`. Cheap, fast, no S3 round trip.
2. **Re-deploy from S3.** lambda-perf's approach — fetch the zip from S3, `UpdateFunctionCode`, invoke. More realistic in the sense that it mimics an actual deploy, slightly slower per sample.

We will use option 1. It is sufficient to invalidate the environment and is faster, which matters when we are running 2,100+ invocations across the matrix.

### 4.2 Measurement

Every Lambda invocation produces a `REPORT` log line in CloudWatch Logs that contains the metrics we care about. For cold starts the line includes an `Init Duration` field; for warm invocations it does not. The harness identifies cold starts by the presence of `Init Duration` in the REPORT line.

Fields we capture per invocation:

- `Init Duration` (ms) — time spent in the init phase. This is what the layer overhead lands on for non-SnapStart cells.
- `Restore Duration` (ms) — present instead of `Init Duration` on SnapStart cold starts; represents the time to restore from the snapshot. We record this field for the two Python SnapStart variant columns.
- `Billed Duration` (ms) — what AWS actually charges for. For functions without SnapStart, init duration is not part of billed duration on the first invoke (per AWS docs on the Lambda programming model). For SnapStart, restore duration is billed.
- `Duration` (ms) — handler execution time on this invoke. For a no-op handler this should be near-zero, useful as a sanity check.
- `Memory Size` (MB) — configured, just for cell labeling.
- `Max Memory Used` (MB) — useful for verifying the small-memory cells don't OOM with ADOT attached.

We do not use X-Ray or any in-handler timing for the primary measurement. The REPORT line is the source of truth because it is produced by the Lambda runtime itself, includes the init phase that in-handler code cannot observe, and is the same metric lambda-perf publishes (so our results are directly comparable for the baseline columns).

### 4.3 Sample size and aggregation

50 cold samples per cell, gathered as five runs of ten samples each, spread across at least 48 hours of wall clock time. For each cell we report p50, p90, p99, min, max, and the sample count. The full per-sample series is also saved as JSON so anyone can re-compute distributions or plot them differently.

### 4.4 Phase 1 export configuration: no-op

For the cold start matrix we configure the ADOT collector with a no-op pipeline — the collector still loads, the language SDK still auto-instruments, but spans go to a `debug` (verbosity: basic) or `nop` exporter rather than over the network. The reason: ADOT exports happen asynchronously after init, so for cold start init duration the network endpoint should not matter, but using no-op guarantees the result is not contaminated by OpenObserve availability or network jitter. Confirming this assumption is the first thing the data will show us — if no-op and live export produce different init durations, that itself is a finding.

### 4.5 Phase 2 export configuration: live OpenObserve

For the steady-state benchmark we point the collector's OTLP exporter at a real OpenObserve instance (small EC2 box in the same region). Auto-instrumentation only matters if there is something to instrument, so the Phase 2 handler does real work: a DynamoDB `GetItem` against a one-item table, returning the item as JSON. This is the most common Lambda pattern in production (API Gateway → Lambda → DynamoDB) and the AWS SDK instrumentation in both `@opentelemetry/instrumentation-aws-sdk` and `opentelemetry-instrumentation-botocore` covers it. The work itself is single-digit milliseconds, so the ADOT delta is visible against a low-variance baseline.

Phase 2 runs a smaller matrix: same three runtimes, baseline vs +ADOT, three memory sizes (512, 1024, 1769), with 100 warm invocations per cell. The Rust column is again collector-extension-only.

---

## 5. Infrastructure

### 5.1 Region

us-east-1. Selected because it is in the published ADOT layer region list, is the lowest-priced standard region, and tends to have the most stable per-invoke latency due to capacity scale.

### 5.2 Account

Existing sandbox AWS account. No production-account touchpoints.

### 5.3 CDK stack structure

One CDK app (TypeScript) with three stacks:

1. **`BenchmarkStack`** — the 56 (Phase 1) + 18 (Phase 2) Lambda functions, their IAM roles, the DynamoDB table for Phase 2, and the published ADOT layer ARNs wired in. Functions are named deterministically (`bench-{phase}-{runtime}-{variant}-{memory}`) so the harness can iterate them. The two Python SnapStart variant functions have `SnapStart.ApplyOn = PublishedVersions` set in CDK and are invoked via a published version ARN.
2. **`HarnessStack`** — the runner. Either a single Lambda that walks the matrix, or a small EC2/Fargate task. Calls `UpdateFunctionConfiguration` then `Invoke` per sample, then queries CloudWatch Logs for the REPORT line and writes the parsed data to S3 as JSON.
3. **`ResultsStack`** (optional) — the S3 bucket + CloudFront distribution serving the static site, if we don't use GitHub Pages. (Default plan is GitHub Pages, so this stack is only needed if we change our minds.)

### 5.4 Handler code

Phase 1 handlers are minimal hello-world equivalents — return an empty object, no I/O, no imports beyond what the runtime auto-loads. Goal is to isolate runtime + layer init cost from any application code cost. Phase 2 handlers add a single `GetItem` call against a fixed key in a small DynamoDB table.

Concretely, for each runtime we ship two zip artifacts: `phase1-handler` (no-op) and `phase2-handler` (DynamoDB read). Both with and without ADOT use the exact same zip — the ADOT variant is purely a layer attachment plus environment variables, no source changes. This is critical for keeping the comparison clean.

For ADOT to actually engage, the Node and Python +ADOT variants set:

- `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler` (Node) or `/opt/otel-instrument` (Python), per ADOT docs.
- `OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-sdk,aws-lambda,http` for Node, matching the documented default.
- `OTEL_EXPORTER_OTLP_ENDPOINT` — unset for Phase 1 (collector configured with no-op), pointed at the O2 box for Phase 2.

Rust +ADOT (collector-extension only) attaches the collector layer but sets no exec wrapper — the binary runs unmodified, the collector extension process just starts alongside it.

### 5.5 Forcing cold starts — harness loop

For each sample in each cell, the harness:

1. Issues `UpdateFunctionConfiguration` with a changed env var (`COLD_START_NONCE=<unix-ts>`).
2. Polls `GetFunctionConfiguration` until `LastUpdateStatus == "Successful"`.
3. Issues `Invoke` with empty payload.
4. Waits for the log line, fetches the REPORT line from CloudWatch Logs, parses it, and appends to a per-cell JSON file.

The polling step matters: invoking before the config update completes can produce a warm invocation against the old config, which both contaminates the sample and produces a stale result.

---

## 6. Phase 1: Cold start matrix

Phase 1 produces the main deliverable — a published table of cold start init durations per runtime, per memory size, with and without ADOT. Run order: deploy the CDK stack, run the harness five times spread over 48 hours, aggregate the JSON, generate the site.

Expected outputs:

- `data/phase1/raw/{run-id}/{cell-id}.json` — every sample, with timestamp, init duration, billed duration, max memory.
- `data/phase1/aggregated.json` — p50/p90/p99/min/max/n per cell.
- A page on the static site showing the matrix as a heatmap or grouped bar chart.

What the data will tell us (or not):

- The ADOT overhead in absolute milliseconds per runtime per memory size. **Number unknown until measured.**
- Whether ADOT overhead scales linearly with memory (i.e., is CPU-bound) or is fixed (i.e., is I/O-bound on layer extraction). **Unknown.**
- Whether the no-op export assumption holds — verified by spot-checking a few cells with live OpenObserve export and comparing init durations. **Unknown.**
- Whether ADOT's memory footprint at small memory configurations causes OOM. We have a fallback: if 128 MB cells fail with ADOT attached, we record that as a result and report the smallest viable memory size.

---

## 7. Phase 2: Steady-state per-invocation overhead

Phase 2 measures what ADOT auto-instrumentation costs on every warm invocation when the handler does real work. The handler reads a single DynamoDB item by primary key and returns it. The DynamoDB table is pre-provisioned with one item; reads are on-demand pricing, single-digit milliseconds, in-region.

Matrix: 3 runtimes × 2 variants × 3 memory sizes (512, 1024, 1769) × 100 warm invocations = 1,800 invocations total.

To get warm invocations: invoke the function once to force a cold start, then invoke 100 times back-to-back. Discard the first invocation (the cold one). Record `Duration` from each REPORT line.

OpenObserve setup for Phase 2:

- Single EC2 instance, ARM64. Start with `t4g.small` as the cheapest viable option; OpenObserve's stated minimums and the Phase 2 ingest volume (~1,800 spans over minutes) should fit, but we will verify on first run and scale up if the instance shows resource pressure.
- Same region (us-east-1), same VPC reachable from Lambda. Avoids cross-region transfer cost.
- Runs only during Phase 2 execution, then shut down. Spinning up takes minutes, the benchmark itself takes minutes, total cost dominated by the EC2 instance hourly rate which is fractions of a dollar.

What the data will tell us:

- Per-invocation overhead in milliseconds from ADOT auto-instrumentation, by runtime and memory size. **Unknown until measured.**
- Whether the overhead is consistent or has a tail (the collector flushing on shutdown can show up as a `Billed Duration` bump even if `Duration` looks fine). **Unknown.**
- Whether the live OpenObserve export creates any back-pressure visible to the function. **Unknown.**

---

## 8. Phase 3: Results site

GitHub Pages, hosted from the same repo as the harness and CDK. Static HTML + a single JSON file per phase per run. Page reads the JSON and renders charts client-side (Chart.js or similar — we won't ship a build pipeline for this, vanilla is fine).

Trigger: manual, via a GitHub Action with `workflow_dispatch`. No cron. Re-run when AWS announces an ADOT release or a runtime update we care about. The Action runs the CDK deploy, runs the harness, commits the aggregated JSON, and the site picks it up on next page load.

Every published dataset on the site records:

- Date and time of run.
- Region.
- ADOT layer ARN and version (for the variant that uses it).
- Runtime version exactly as Lambda reports it.
- Number of samples per cell.
- The harness Git commit SHA.

This is the difference between a useful published benchmark and a screenshot.

---

## 9. Cost estimate

All figures are for us-east-1 ARM64 unless noted. Sources for the rates are listed in the References section.

Verified per-unit rates:

- Lambda compute (ARM64): $0.0000133334 per GB-second.
- Lambda requests: $0.20 per million.
- CloudWatch Logs ingestion (Lambda logs): tiered, starts at $0.50 per GB.
- CloudWatch Logs storage: $0.03 per GB-month.
- EC2 `t4g.small` on-demand (us-east-1): approximately $0.0168/hour. (Confirm at deploy time — EC2 pricing can change.)

Phase 1 (cold start matrix), single full run:

- Cells: 56. Samples per cell: 10. Total invocations: 560 per run, 2,800 across the 5 planned runs.
- Worst-case assumption: every invocation runs for 5 seconds at the maximum 10,240 MB configuration. Compute: 2,800 × 5 × 10 = 140,000 GB-seconds. Cost: 140,000 × $0.0000133334 ≈ **$1.87**.
- Realistic assumption: average init + first invoke ≈ 1.5 seconds, average memory weighted across the sweep ≈ 2.5 GB. Compute: 2,800 × 1.5 × 2.5 ≈ 10,500 GB-seconds ≈ **$0.14**.
- Request charges: 2,800 × $0.20 / 1,000,000 = **$0.0006**. Free tier easily absorbs this.
- CloudWatch Logs: each REPORT line plus surrounding context is on the order of 1 KB. 2,800 lines × ~1 KB ≈ 3 MB. At $0.50/GB ingestion: **$0.0015**.
- **Phase 1 total: under $2 even in the worst case, realistic estimate under $0.20.**

Phase 2 (steady state), single full run:

- Cells: 18. Samples per cell: 100. Plus one cold per cell, discarded. Total invocations: 1,818.
- Compute, realistic (50 ms per warm invoke at average 1 GB): 1,818 × 0.05 × 1 ≈ 91 GB-seconds ≈ **$0.001**.
- EC2 for OpenObserve: 4 hours of uptime to bracket the run = 4 × $0.0168 ≈ **$0.07**.
- DynamoDB on-demand: 1,818 reads × $0.25 per million ≈ **$0.0005**.
- CloudWatch Logs: similar to Phase 1, dominated by REPORT lines. **$0.001**.
- **Phase 2 total: under $0.10 per run.**

If we leave OpenObserve running between runs (instead of spinning it up each time), add ~$12/month. Recommend shutting it down between runs.

Static site hosting on GitHub Pages: free. GitHub Actions free tier (2,000 minutes/month for private repos, unlimited for public) is sufficient — a full run is under 30 minutes of compute.

**Total budget for the whole benchmark, even running it five times: under $20.** The constraint here is engineering time, not AWS spend.

---

## 10. Open questions

The following are deliberately left unanswered in this doc because they should be settled by the data, not by guessing:

1. How much does ADOT actually cost on cold start for Node 24 at 512 MB ARM64? At 1769 MB? At 128 MB?
2. Does ADOT cold start overhead scale with memory (CPU-bound) or stay roughly fixed (I/O-bound on layer extraction)?
3. Does ADOT push the 128 MB cells to OOM, and if so, what is the smallest viable memory size with ADOT attached?
4. Is the no-op vs live OpenObserve assumption (that they produce statistically equivalent init durations) correct?
5. For Phase 2: does ADOT's auto-instrumentation add a measurable tail to warm-invoke duration, or is the cost only at init?
6. For Rust: how much does the standalone collector extension cost on cold start, with no language SDK involved?
7. Does Python SnapStart meaningfully reduce the restore duration relative to the non-SnapStart init duration, both with and without ADOT? (SnapStart snapshots the initialized execution environment, so ADOT's init-time patching work should be amortized — this is the key hypothesis to validate.)
8. Does attaching the ADOT layer change the restore duration for SnapStart functions, and if so, by how much relative to the no-ADOT SnapStart baseline?

Questions that need a human decision before we cut code:

9. Region: us-east-1 vs anywhere else? (Recommendation: us-east-1.)
10. Should the Phase 2 handler use DynamoDB, or something else? (Recommendation: DynamoDB.)
11. Should we test additional Node or Python versions in a follow-on, or is one version per runtime enough for the first publication? (Recommendation: one version per runtime for v1, add more if the numbers are interesting.)
12. Where does the OpenObserve test instance live — same AWS account, separate account, or self-hosted somewhere else? (Recommendation: same sandbox account, smallest EC2 we can run it on, shut down between runs.)

---

## 11. Success criteria

The benchmark is done when:

1. The Phase 1 matrix has at least 50 cold samples per cell across at least 48 hours of wall clock time, with results published as JSON and rendered on the site.
2. The Phase 2 numbers are published for the three chosen memory sizes.
3. The site clearly shows ADOT-attached vs baseline for every cell, with the ADOT layer version recorded.
4. The harness can be re-run on demand via a GitHub Action without manual setup.
5. A short writeup translates the numbers into a recommendation: for Node/Python at typical production memory sizes, is ADOT acceptable, or do we go with CloudWatch-to-OpenObserve piping?

---

## 12. References

ADOT Lambda documentation:

- [ADOT Lambda overview](https://aws-otel.github.io/docs/getting-started/lambda)
- [ADOT Python Lambda layer](https://aws-otel.github.io/docs/getting-started/lambda/lambda-python) — confirms Python 3.8–3.13 support and the ARN format
- [ADOT JavaScript Lambda layer](https://aws-otel.github.io/docs/getting-started/lambda/lambda-js) — confirms Node 18+ support and the ARN format
- [aws-observability/aws-otel-lambda repo](https://github.com/aws-observability/aws-otel-lambda) — lists current layer versions including the standalone collector layer

Lambda fundamentals:

- [Lambda runtimes documentation](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) — current supported runtimes
- [Lambda function memory configuration](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html) — confirms 1 vCPU at 1769 MB
- [AWS announcement: Lambda Rust GA](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-lambda-rust/) — November 14, 2025

Pricing:

- [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/) — confirms ARM64 rate of $0.0000133334 per GB-second and request rate of $0.20 per million
- [Amazon CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/) — log ingestion and storage rates

Prior art and methodology:

- [lambda-perf project](https://github.com/maxday/lambda-perf) — methodology we are extending; baseline numbers we can cross-check against
- [lambda-perf published results](https://maxday.github.io/lambda-perf/) — the UX pattern we are following for our site
