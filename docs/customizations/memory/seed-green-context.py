#!/usr/bin/env python3
"""Seed one green memory identity from a reviewed local JSON manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("owner", choices=("dima", "kate"))
parser.add_argument("manifest", type=Path)
args = parser.parse_args()
items = json.loads(args.manifest.read_text())
if not isinstance(items, list) or not 1 <= len(items) <= 10:
    parser.error("Expected 1–10 context records")
for item in items:
    if set(item) != {"text", "source"} or not all(isinstance(v, str) and v.strip() for v in item.values()):
        parser.error("Each record needs text and source")
if sum(len(item["text"]) for item in items) > 1200:
    parser.error("Seed profile exceeds 1200 characters")

identity = f"ai-control-green-{args.owner}"
digest = hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
seed = f"green-bootstrap-{digest}"


def request(port, path, method="GET", data=None, missing=False):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise


base = f"/v3/workspaces/{identity}"
request(18080, "/v3/workspaces", "POST", {"id": identity})
request(18080, base + "/peers", "POST", {"id": args.owner})
request(18080, base + "/sessions", "POST", {"id": seed, "peers": {args.owner: {}}})
messages = request(18080, base + f"/sessions/{seed}/messages/list", "POST", {})
existing = {row.get("content") for row in messages.get("items", [])}
wanted = [{"peer_id": args.owner, "content": item["text"], "metadata": {"source": item["source"]}} for item in items]
missing = [entry for entry in wanted if entry["content"] not in existing]
if missing:
    request(18080, base + f"/sessions/{seed}/messages", "POST", {"messages": missing})
card_path = base + f"/peers/{args.owner}/card"
card = request(18080, card_path)
if isinstance(card, dict) and not card.get("peer_card"):
    request(18080, card_path, "PUT", {"peer_card": [item["text"] for item in items]})

bank = f"/v1/default/banks/{identity}"
doc = bank + "/documents/" + seed
if request(18888, doc, missing=True) is None:
    request(18888, bank + "/memories", "POST", {
        "items": [{"document_id": seed, "content": "\n".join(item["text"] for item in items),
                   "metadata": {"source": ", ".join(item["source"] for item in items)}}],
        "async": False,
    })
assert request(18888, doc) is not None
print(f"{identity}: verified seed {seed}, {len(items)} records")
