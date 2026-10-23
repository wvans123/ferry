#!/usr/bin/env sh
# Linux: load .env and start the Ferry server
set -e
cd "$(dirname "$0")"
[ -f .env ] || { echo ".env not found: copy .env.example to .env and fill it in" >&2; exit 1; }
set -a
. ./.env
set +a
exec ferry-server --config ferry-server.toml
