#!/usr/bin/env python3
"""
Harness runner for the ADOT Lambda cold start benchmark.

Usage:
  python harness/run.py --phase 1
  python harness/run.py --phase 2 --o2-endpoint http://<ec2-ip>:4317
  python harness/run.py --phase 1 --cells 1 --samples 1   # dry-run

Reads docs/data/snapstart-versions.json (written by the GitHub Actions workflow
after PublishVersion) to get version ARNs for Python SnapStart variants.

Writes per-cell JSON to docs/data/phase{N}/raw/{run_id}/ and uploads the same
files to S3 (bucket name from env RESULTS_BUCKET). After all cells, writes
docs/data/phase{N}/aggregated.json.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import boto3

REGION = "us-east-1"
MEMORY_SIZES_P1 = [128, 256, 512, 1024, 1769, 3008, 10240]
MEMORY_SIZES_P2 = [512, 1024, 1769]

# Phase 1 cell definitions: (runtime_key, variant, memory)
# Matches the function names deployed by BenchmarkStack.
PHASE1_CELLS = [
    *[("node", "baseline", m) for m in MEMORY_SIZES_P1],
    *[("node", "adot", m) for m in MEMORY_SIZES_P1],
    *[("python", "baseline", m) for m in MEMORY_SIZES_P1],
    *[("python", "adot", m) for m in MEMORY_SIZES_P1],
    *[("python", "snapstart", m) for m in MEMORY_SIZES_P1],
    *[("python", "snapstart-adot", m) for m in MEMORY_SIZES_P1],
    *[("rust", "baseline", m) for m in MEMORY_SIZES_P1],
    *[("rust", "adot", m) for m in MEMORY_SIZES_P1],
]

PHASE2_CELLS = [
    *[("node", "baseline", m) for m in MEMORY_SIZES_P2],
    *[("node", "adot", m) for m in MEMORY_SIZES_P2],
    *[("python", "baseline", m) for m in MEMORY_SIZES_P2],
    *[("python", "adot", m) for m in MEMORY_SIZES_P2],
    *[("rust", "baseline", m) for m in MEMORY_SIZES_P2],
    *[("rust", "adot", m) for m in MEMORY_SIZES_P2],
]

SNAPSTART_VARIANTS = {"snapstart", "snapstart-adot"}


def fn_name(phase: int, runtime: str, variant: str, memory: int) -> str:
    return f"bench-p{phase}-{runtime}-{variant}-{memory}"


def cell_id(runtime: str, variant: str, memory: int) -> str:
    return f"{runtime}-{variant}-{memory}"


def parse_report_line(report: str) -> dict:
    """Extract fields from a Lambda REPORT log line."""

    def extract(pattern, text):
        m = re.search(pattern, text)
        return float(m.group(1)) if m else None

    return {
        "init_duration_ms": extract(r"Init Duration: ([\d.]+) ms", report),
        "restore_duration_ms": extract(r"Restore Duration: ([\d.]+) ms", report),
        "billed_duration_ms": extract(r"Billed Duration: (\d+) ms", report),
        "duration_ms": extract(r"Duration: ([\d.]+) ms", report),
        "max_memory_used_mb": extract(r"Max Memory Used: (\d+) MB", report),
    }


def wait_for_update(lam, name: str, timeout: int = 120):
    """Poll until LastUpdateStatus == Successful (design doc §5.5 step 2)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = lam.get_function_configuration(FunctionName=name)
        status = resp.get("LastUpdateStatus")
        if status == "Successful":
            return
        if status == "Failed":
            raise RuntimeError(f"Function update failed for {name}: {resp.get('LastUpdateStatusReason')}")
        time.sleep(2)
    raise TimeoutError(f"Timed out waiting for {name} update after {timeout}s")


def fetch_report_line(logs, log_group: str, request_id: str, retries: int = 10) -> str:
    """Fetch the REPORT log line for a given request ID (design doc §4.2)."""
    for attempt in range(retries):
        time.sleep(2 + attempt)  # CloudWatch Logs has ingestion lag
        resp = logs.filter_log_events(
            logGroupName=log_group,
            filterPattern=f'"REPORT RequestId: {request_id}"',
        )
        for event in resp.get("events", []):
            if "REPORT RequestId:" in event["message"] and request_id in event["message"]:
                return event["message"]
    raise RuntimeError(f"REPORT line for {request_id} not found in {log_group}")


def percentile(data: list, p: float) -> float:
    if not data:
        return 0.0
    sorted_data = sorted(data)
    index = (p / 100) * (len(sorted_data) - 1)
    lower = int(index)
    upper = min(lower + 1, len(sorted_data) - 1)
    frac = index - lower
    return sorted_data[lower] + frac * (sorted_data[upper] - sorted_data[lower])


def aggregate_cell(samples: list) -> dict:
    """Compute p50/p90/p99/min/max/n from a list of sample dicts."""
    # Use init_duration_ms for non-SnapStart; restore_duration_ms for SnapStart.
    durations = [
        s.get("restore_duration_ms") or s.get("init_duration_ms")
        for s in samples
        if (s.get("restore_duration_ms") or s.get("init_duration_ms")) is not None
    ]
    if not durations:
        return {"n": len(samples), "oom_count": len(samples)}
    return {
        "p50": round(percentile(durations, 50), 2),
        "p90": round(percentile(durations, 90), 2),
        "p99": round(percentile(durations, 99), 2),
        "min": round(min(durations), 2),
        "max": round(max(durations), 2),
        "n": len(durations),
        "oom_count": sum(1 for s in samples if s.get("oom")),
    }


def run_cell(
    lam,
    logs,
    s3,
    phase: int,
    runtime: str,
    variant: str,
    memory: int,
    num_samples: int,
    run_id: str,
    results_bucket: str | None,
    snapstart_versions: dict,
    o2_endpoint: str | None,
) -> dict:
    name = fn_name(phase, runtime, variant, memory)
    cid = cell_id(runtime, variant, memory)
    log_group = f"/aws/lambda/{name}"

    is_snapstart = variant in SNAPSTART_VARIANTS
    # SnapStart functions must be invoked via a published version ARN.
    invoke_target = snapstart_versions.get(name, name) if is_snapstart else name

    # For Phase 2 ADOT variants, set the OpenObserve endpoint before running.
    if phase == 2 and "adot" in variant and o2_endpoint:
        lam.update_function_configuration(
            FunctionName=name,
            Environment={
                "Variables": {
                    "OTEL_EXPORTER_OTLP_ENDPOINT": o2_endpoint,
                    "COLD_START_NONCE": "o2-setup",
                }
            },
        )
        wait_for_update(lam, name)

    # Fetch the deployed env vars once so nonce updates don't wipe them.
    # UpdateFunctionConfiguration replaces the entire Environment object.
    base_env = (
        lam.get_function_configuration(FunctionName=name)
        .get("Environment", {})
        .get("Variables", {})
    )

    samples = []

    for i in range(num_samples):
        nonce = str(int(time.time() * 1000))

        # Step 1: trigger a cold start by changing an env var (design doc §5.5).
        lam.update_function_configuration(
            FunctionName=name,
            Environment={"Variables": {**base_env, "COLD_START_NONCE": nonce}},
        )

        # Step 2: wait for the update to propagate.
        wait_for_update(lam, name)

        # Step 3: invoke.
        sample: dict = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "runtime": runtime,
            "variant": variant,
            "memory_mb": memory,
            "sample_index": i,
        }
        try:
            invoke_resp = lam.invoke(
                FunctionName=invoke_target,
                InvocationType="RequestResponse",
                LogType="None",
                Payload=b"{}",
            )
            request_id = invoke_resp["ResponseMetadata"]["RequestId"]
            sample["request_id"] = request_id

            if invoke_resp.get("FunctionError"):
                # OOM or timeout — record it as a result (design doc §6 fallback).
                sample["oom"] = True
                samples.append(sample)
                print(f"  [{name}] sample {i}: ERROR {invoke_resp.get('FunctionError')}")
                continue

            # Step 4+5: fetch REPORT line and parse it.
            report_line = fetch_report_line(logs, log_group, request_id)
            parsed = parse_report_line(report_line)
            sample.update(parsed)

            duration_field = "restore_duration_ms" if is_snapstart else "init_duration_ms"
            print(
                f"  [{name}] sample {i}: {duration_field}={sample.get(duration_field)} ms  "
                f"billed={sample.get('billed_duration_ms')} ms  "
                f"maxMem={sample.get('max_memory_used_mb')} MB"
            )

        except Exception as exc:
            sample["error"] = str(exc)
            print(f"  [{name}] sample {i}: EXCEPTION {exc}", file=sys.stderr)

        samples.append(sample)

    # Write per-cell JSON to disk.
    out_dir = Path(f"docs/data/phase{phase}/raw/{run_id}")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{cid}.json"
    out_file.write_text(json.dumps({"cell_id": cid, "samples": samples}, indent=2))

    # Upload to S3 if a bucket is configured.
    if results_bucket and s3:
        s3_key = f"phase{phase}/raw/{run_id}/{cid}.json"
        s3.put_object(
            Bucket=results_bucket,
            Key=s3_key,
            Body=out_file.read_bytes(),
            ContentType="application/json",
        )

    return {"cell_id": cid, "samples": samples}


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", type=int, required=True, choices=[1, 2])
    parser.add_argument("--samples", type=int, default=10,
                        help="Cold samples per cell (default: 10, design doc §3)")
    parser.add_argument("--cells", type=int, default=0,
                        help="Limit to first N cells (0 = all; use 1 for dry-run)")
    parser.add_argument("--o2-endpoint", default=os.environ.get("O2_ENDPOINT"),
                        help="OpenObserve OTLP endpoint for Phase 2 ADOT variants")
    args = parser.parse_args()

    session = boto3.Session(region_name=REGION)
    lam = session.client("lambda")
    logs = session.client("logs")
    results_bucket = os.environ.get("RESULTS_BUCKET")
    s3 = session.client("s3") if results_bucket else None

    # Load SnapStart version ARNs published by the workflow.
    snapstart_versions: dict = {}
    sv_path = Path("docs/data/snapstart-versions.json")
    if sv_path.exists():
        snapstart_versions = json.loads(sv_path.read_text())

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    cells = PHASE1_CELLS if args.phase == 1 else PHASE2_CELLS
    if args.cells:
        cells = cells[: args.cells]

    print(f"Run {run_id} | phase {args.phase} | {len(cells)} cells × {args.samples} samples")

    all_cell_results = []
    for runtime, variant, memory in cells:
        print(f"\n→ {fn_name(args.phase, runtime, variant, memory)}")
        result = run_cell(
            lam=lam,
            logs=logs,
            s3=s3,
            phase=args.phase,
            runtime=runtime,
            variant=variant,
            memory=memory,
            num_samples=args.samples,
            run_id=run_id,
            results_bucket=results_bucket,
            snapstart_versions=snapstart_versions,
            o2_endpoint=args.o2_endpoint,
        )
        all_cell_results.append(result)

    # Aggregate results (design doc §4.3).
    aggregated = {
        "meta": {
            "run_id": run_id,
            "phase": args.phase,
            "region": REGION,
            "harness_sha": git_sha(),
            "samples_per_cell": args.samples,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "cells": {
            r["cell_id"]: aggregate_cell(r["samples"]) for r in all_cell_results
        },
    }

    agg_path = Path(f"docs/data/phase{args.phase}/aggregated.json")
    agg_path.parent.mkdir(parents=True, exist_ok=True)
    agg_path.write_text(json.dumps(aggregated, indent=2))
    print(f"\nAggregated results written to {agg_path}")

    if results_bucket and s3:
        s3.put_object(
            Bucket=results_bucket,
            Key=f"phase{args.phase}/aggregated.json",
            Body=agg_path.read_bytes(),
            ContentType="application/json",
        )
        print(f"Uploaded aggregated JSON to s3://{results_bucket}/phase{args.phase}/aggregated.json")


if __name__ == "__main__":
    main()
