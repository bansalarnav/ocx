#!/usr/bin/env bash
set -euo pipefail

port="${OPENCODE_DEVICE_PORT:-7331}"

exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port"
