#!/usr/bin/env python3
"""Prepare an isolated DSH web profile for one personal memory identity."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("profile", type=Path)
parser.add_argument("identity", choices=("dima", "kate"))
parser.add_argument("reader", choices=("honcho", "hindsight"))
parser.add_argument("--channel", choices=("red", "green", "smoke"), default="red")
parser.add_argument("--honcho", required=True, type=Path)
parser.add_argument("--hindsight", required=True, type=Path)
parser.add_argument("--standard-preset", required=True, type=Path)
parser.add_argument("--frontend", required=True, type=Path)
parser.add_argument("--client-plugins", required=True, type=Path)
args = parser.parse_args()

os.umask(0o077)
profile = args.profile.resolve(strict=True)
identity = f"ai-control-{args.channel}-{args.identity}"
state = profile / "personal-memory"
state.mkdir(exist_ok=True)
client_plugins = args.client_plugins.resolve(strict=True)
for client in (client_plugins / "ui-sidebar", client_plugins / "ui-workspace"):
    if not (client / "lib/index.js").is_file() or not (client / "lib/client.js").is_file():
        parser.error(f"Client plugin is not built at {client}")
for name, path, entry in [
    ("@honcho-ai/dsh-honcho", args.honcho, "lib/index.js"),
    ("@vectorize-io/hindsight-coding-agents", args.hindsight, "dist/dsh.js"),
]:
    target = path.resolve(strict=True)
    if not (target / entry).is_file() or (name == "@honcho-ai/dsh-honcho" and not (target / "index.js").is_file()):
        parser.error(f"Build artifact missing at {target / entry}")
    link = profile / "node_modules" / name
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() and link.resolve() == target:
        continue
    if link.exists() or link.is_symlink():
        parser.error(f"Existing adapter at {link}")
    link.symlink_to(target, target_is_directory=True)

honcho = {
    "peerName": args.identity,
    "baseUrl": "http://127.0.0.1:18080",
    "auth": {"apiKey": "local"},
    "hosts": {"dsh": {
        "workspace": identity,
        "sessionStrategy": "per-session",
        "capture": {"saveMessages": True, "saveToolUse": False},
        "injection": {"sessionStart": [], "perTurn": [], "tools": False},
    }},
}
(state / "honcho.json").write_text(json.dumps(honcho, indent=2) + "\n")
hindsight = {
    "serverMode": "self-hosted",
    "apiUrl": "http://127.0.0.1:18888",
    "bankId": identity,
    "dynamicBankId": False,
    "autoSeed": False,
    "gitIngest": "none",
    "autoInject": "none",
    "writeTools": False,
    "autoUpdate": False,
}
(state / "hindsight.json").write_text(json.dumps(hindsight, indent=2) + "\n")

patch = profile / "cordis.patch.yml"
start = "# BEGIN AI Control personal memory"
end = "# END AI Control personal memory"
current = patch.read_text()
if start in current:
    head, remainder = current.split(start, 1)
    if end not in remainder:
        parser.error(f"Unterminated memory block in {patch}")
    current = head + remainder.split(end, 1)[1]
preset = args.standard_preset.read_text().replace("id: preset-standard", "id: preset-memory-off", 1)
preset = preset.replace("id: standard", "id: memory-off", 1).replace("order: 1", "order: 90", 1)
if "id: memory-off" not in preset:
    parser.error("Could not derive the no-memory preset from the standard preset")
patch.write_text(current.rstrip() + "\n\n" + start + f"""
- id: web-runtime
  name: '@deepseek-ai/dsh-web-app/src/index.ts'
- id: modules
  name: '@deepseek-ai/dsh-client-modules/src/index.ts'
- insert:
    - id: honcho-personal-memory
      name: '@honcho-ai/dsh-honcho'
      config:
        configPath: {json.dumps(str(state / "honcho.json"))}
    - id: hindsight-personal-memory
      name: '@vectorize-io/hindsight-coding-agents/dsh'
""" + preset.rstrip() + "\n" + end + "\n")

environment = {
    "AI_CONTROL_MEMORY_PERSONAL": "1",
    "AI_CONTROL_MEMORY_READER": args.reader,
    "AI_CONTROL_WEB_DIST": str(args.frontend.resolve(strict=True)),
    "AI_CONTROL_MEMORY_CLIENT_PLUGINS": str(client_plugins),
    "HONCHO_CONFIG_DIR": str(state / "honcho-state"),
    "HINDSIGHT_CONFIG": str(state / "hindsight.json"),
    "HINDSIGHT_BANK_ID": identity,
    "HINDSIGHT_LOG_FILE": str(state / "hindsight.log"),
    "HINDSIGHT_USAGE_FILE": str(state / "hindsight-usage.jsonl"),
}
(state / "systemd.env").write_text("".join(f"{name}={json.dumps(value)}\n" for name, value in environment.items()))
print(state / "systemd.env")
