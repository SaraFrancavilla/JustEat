#!/usr/bin/env bash
set -e

PROJECT_DIR="/mnt/c/Users/anjel/Desktop/ASA/Project"
PAAS_DIR="$HOME/tools/planning-as-a-service/server"

cleanup() {
  echo ""
  echo "[PaaS] Stopping containers..."
  cd "$PAAS_DIR"
  docker compose down
}

trap cleanup EXIT INT TERM

echo "[PaaS] Starting containers from WSL Linux folder..."
cd "$PAAS_DIR"
docker compose up -d

echo "[PaaS] Waiting for MySQL container..."
for i in {1..60}; do
  if docker compose ps mysql | grep -q "Up"; then
    echo "[PaaS] MySQL is up."
    break
  fi

  if [ "$i" -eq 60 ]; then
    echo "[PaaS] MySQL did not start."
    docker compose logs mysql --tail=80
    exit 1
  fi

  sleep 1
done

echo "[PaaS] Waiting a bit for workers to connect..."
sleep 15

echo "[PaaS] Restarting worker/web after MySQL startup..."
docker compose restart worker web monitor mcp >/dev/null

echo "[PaaS] Waiting for API..."
for i in {1..60}; do
  if curl -s http://localhost:5001/solver/ >/dev/null; then
    echo "[PaaS] API ready."
    break
  fi

  if [ "$i" -eq 60 ]; then
    echo "[PaaS] API did not become ready."
    docker compose ps
    docker compose logs worker --tail=80
    exit 1
  fi

  sleep 1
done

explorer.exe "https://deliveroojs.onrender.com/" >/dev/null 2>&1 || true

echo "[Node] Starting project..."
cd "$PROJECT_DIR"
node src/index.js