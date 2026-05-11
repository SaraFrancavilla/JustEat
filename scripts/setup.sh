#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PAAS_REPO_DIR="${PAAS_REPO_DIR:-$HOME/tools/planning-as-a-service}"
PAAS_DIR="$PAAS_REPO_DIR/server"
PAAS_GIT_URL="${PAAS_GIT_URL:-https://github.com/AI-Planning/planning-as-a-service.git}"

copy_example() {
  local example_file="$1"
  local target_file="$2"

  if [[ -f "$example_file" && ! -f "$target_file" ]]; then
    cp "$example_file" "$target_file"
    echo "[setup] Created $(basename "$target_file") from $(basename "$example_file")"
  fi
}

ensure_paas_repo() {
  mkdir -p "$(dirname "$PAAS_REPO_DIR")"

  if [[ ! -d "$PAAS_REPO_DIR/.git" ]]; then
    echo "[setup] Cloning planning-as-a-service in Ubuntu: $PAAS_REPO_DIR"
    git clone "$PAAS_GIT_URL" "$PAAS_REPO_DIR"
  else
    echo "[setup] planning-as-a-service already available in: $PAAS_REPO_DIR"
  fi
}

echo "[setup] Preparing project in $PROJECT_DIR"
ensure_paas_repo

copy_example "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
copy_example "$PAAS_DIR/.env.example" "$PAAS_DIR/.env"

echo "[setup] Installing Node dependencies"
cd "$PROJECT_DIR"
npm install

echo "[setup] Done"
echo "[setup] Start with: npm start"