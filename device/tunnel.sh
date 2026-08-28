#!/usr/bin/env bash
set -euo pipefail

port="${OPENCODE_DEVICE_PORT:-7331}"
name="${OPENCODE_DEVICE_TUNNEL_NAME:-opencode-mcp}"

exec tnlc expose "$port" --name "$name"
