#!/usr/bin/env python3
"""
Publish a Lambda version for every Python SnapStart function so the harness
can invoke them via a version ARN. Safe to re-run — each call creates a new
version but the harness always uses the latest published one.

Writes docs/data/snapstart-versions.json mapping function name → version ARN.
"""
import boto3
import json
from pathlib import Path

lam = boto3.client("lambda", region_name="us-east-1")
memories = [128, 256, 512, 1024, 1769, 3008, 10240]
variants = ["snapstart", "snapstart-adot"]
versions = {}

for variant in variants:
    for mem in memories:
        name = f"bench-p1-python-{variant}-{mem}"
        resp = lam.publish_version(FunctionName=name)
        versions[name] = resp["FunctionArn"]
        print(f"Published {name} -> {resp['FunctionArn']}")

Path("docs/data").mkdir(parents=True, exist_ok=True)
Path("docs/data/snapstart-versions.json").write_text(json.dumps(versions, indent=2))
print("Wrote docs/data/snapstart-versions.json")
