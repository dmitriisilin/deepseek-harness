#!/usr/bin/env python3
"""Provision the cached personal-profile document in an existing local Hindsight bank."""
import argparse
import json
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("bank")
args = parser.parse_args()
bank = urllib.parse.quote(args.bank, safe="")
base = f"http://127.0.0.1:18888/v1/default/banks/{bank}/mental-models"

try:
    with urllib.request.urlopen(base + "/personal-profile?detail=content", timeout=5):
        print("Personal profile already exists")
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise
    body = {
        "id": "personal-profile",
        "name": "Personal profile",
        "source_query": (
            "In the user's language, summarize only durable preferences and facts "
            "that the user explicitly shared, in at most five short bullets. "
            "Omit credentials, private identifiers, guesses and one-off tasks."
        ),
        "max_tokens": 256,
        "trigger": {"refresh_cron": "17 * * * *", "budget": "low"},
    }
    request = urllib.request.Request(
        base,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10):
        print("Personal profile provisioned")
