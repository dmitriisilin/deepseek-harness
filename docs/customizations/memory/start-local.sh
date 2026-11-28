#!/usr/bin/env bash
set -euo pipefail
umask 077

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/ai-control-memory"
mkdir -p "$state_dir"
secrets_file="${AI_CONTROL_KEYS_FILE:-$HOME/api.keys}"

python3 - "$secrets_file" "$state_dir" <<'PY'
from pathlib import Path
import os
import secrets
import sys

keys = dict(line.split("=", 1) for line in Path(sys.argv[1]).read_text().splitlines()
            if "=" in line and not line.lstrip().startswith("#"))
state = Path(sys.argv[2])
honcho = keys["DEEP_SEEK_Honcho"].strip().strip("\"'")
hindsight = keys["DEEP_SEEK_Hindsight"].strip().strip("\"'")
if not honcho or not hindsight:
    raise SystemExit("Missing DeepSeek keys for memory")

def write(name, entries):
    path = state / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        out.writelines(f"{key}={value}\n" for key, value in entries.items())

password_file = state / "postgres-password"
if not password_file.exists():
    password_file.write_text(secrets.token_hex(24))
password = password_file.read_text().strip()
write("postgres.env", {"POSTGRES_PASSWORD": password})
honcho_env = {
    "DB_CONNECTION_URI": f"postgresql+psycopg://postgres:{password}@honcho-db:5432/postgres",
    "CACHE_ENABLED": "true",
    "CACHE_URL": "redis://honcho-redis:6379/0?suppress=true",
    "LLM_OPENAI_API_KEY": honcho,
    "MEMORY_EMBEDDINGS_KEY": "local",
    "EMBEDDING_VECTOR_DIMENSIONS": "384",
    "EMBEDDING_MODEL_CONFIG__MODEL": "intfloat/multilingual-e5-small",
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL": "http://memory-embeddings:80/v1",
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV": "MEMORY_EMBEDDINGS_KEY",
}
for prefix in (
    "DERIVER_MODEL_CONFIG",
    "SUMMARY_MODEL_CONFIG",
    "DREAM_DEDUCTION_MODEL_CONFIG",
    "DREAM_INDUCTION_MODEL_CONFIG",
    *(f"DIALECTIC_LEVELS__{level}__MODEL_CONFIG" for level in ("MINIMAL", "LOW", "MEDIUM", "HIGH", "MAX")),
):
    honcho_env[prefix + "__MODEL"] = "deepseek-flash"
    honcho_env[prefix + "__OVERRIDES__BASE_URL"] = "https://api.deepseek.com/v1"
    honcho_env[prefix + "__STRUCTURED_OUTPUT_MODE"] = "json_object"
write("honcho.env", honcho_env)
write("hindsight.env", {
    "HINDSIGHT_API_LLM_PROVIDER": "deepseek",
    "HINDSIGHT_API_LLM_API_KEY": hindsight,
    "HINDSIGHT_API_LLM_MODEL": "deepseek-flash",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "openai",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY": "local",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL": "http://memory-embeddings:80/v1",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL": "intfloat/multilingual-e5-small",
    "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
})
PY

honcho_image=ghcr.io/plastic-labs/honcho@sha256:9c5479d33d4d2cbcb54514e7dd24e8580ba5d73906862fb6fe6ea436558a0a14
hindsight_image=ghcr.io/vectorize-io/hindsight@sha256:469ca4b49bf3863ec383cc0c509483bb58180def7c6ae0e6a592dc27369c9ff5
embeddings_image=ghcr.io/huggingface/text-embeddings-inference@sha256:f0a4bb206b9d4877746b5b9f638e138fe683eeb9787c14d541a12c993b562d86

podman network exists ai-control-memory || podman network create ai-control-memory
start() {
  local name=$1
  shift
  if podman container exists "$name"; then
    podman start "$name" >/dev/null
  else
    podman run --detach --name "$name" --network ai-control-memory "$@"
  fi
}

start memory-embeddings --volume ai-memory-embeddings:/data \
  "$embeddings_image" \
  --model-id intfloat/multilingual-e5-small --max-batch-requests 4
start honcho-db --env-file "$state_dir/postgres.env" --volume ai-memory-honcho-db:/var/lib/postgresql/data \
  docker.io/pgvector/pgvector:pg15
start honcho-redis --volume ai-memory-honcho-redis:/data docker.io/library/redis:8.2

for _ in {1..30}; do
  if podman exec honcho-db pg_isready -U postgres >/dev/null; then break; fi
  sleep 1
done
podman exec honcho-db pg_isready -U postgres
if ! podman container exists honcho-api; then
  # A database with existing vector tables must be migrated deliberately.
  tables=$(podman exec honcho-db psql -U postgres -Atc "SELECT to_regclass('public.documents')")
  if [[ -z "$tables" ]]; then
    podman run --rm --network ai-control-memory --env-file "$state_dir/honcho.env" \
      --entrypoint /app/.venv/bin/python "$honcho_image" scripts/provision_db.py
    podman run --rm --network ai-control-memory --env-file "$state_dir/honcho.env" \
      --entrypoint /app/.venv/bin/python "$honcho_image" scripts/configure_embeddings.py --yes
  fi
fi
start honcho-api --env-file "$state_dir/honcho.env" --publish 127.0.0.1:18080:8000 \
  --entrypoint sh "$honcho_image" docker/entrypoint.sh

for _ in {1..45}; do
  if curl --fail --silent http://127.0.0.1:18080/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:18080/health >/dev/null
start honcho-deriver --env-file "$state_dir/honcho.env" --entrypoint /app/.venv/bin/python \
  "$honcho_image" -m src.deriver
start hindsight-api --env-file "$state_dir/hindsight.env" --shm-size 1g \
  --publish 127.0.0.1:18888:8888 --volume ai-memory-hindsight:/home/hindsight/.pg0 \
  "$hindsight_image"

for _ in {1..90}; do
  if curl --fail --silent http://127.0.0.1:18888/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:18888/health >/dev/null
