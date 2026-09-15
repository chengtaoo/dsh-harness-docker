#!/usr/bin/env bash
# Container entrypoint.
#
# Only the licence gateway runs here as a long-lived process. It starts one
# `dsh web` instance per licence on demand, so no dsh process exists until
# somebody logs in.
set -euo pipefail

DSH_LOG_DIR="${DSH_LOG_DIR:-/data/logs}"
DSH_WORKSPACE_ROOT="${GATEWAY_WORKSPACE_ROOT:-/workspace}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"

export DSH_LOG_DIR GATEWAY_PORT

# Offline deployment: no telemetry, no browser launch, no colour codes.
export DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"
export NO_COLOR=1
export DSH_UPSTREAM_HOST=127.0.0.1

log() { printf '[entrypoint] %s\n' "$*"; }

mkdir -p "$DSH_LOG_DIR" /data/users "$DSH_WORKSPACE_ROOT" "$DSH_HOME" 2>/dev/null || true
mkdir -p /data/dsh-home
chmod 700 /data/dsh-home 2>/dev/null || true

# ── preflight ───────────────────────────────────────────────────────────────
# Render the configuration once for a throwaway home, so a bad LLM endpoint or
# a missing variable fails the container at boot instead of at first login.
if [ "${DSH_SKIP_CONFIG_RENDER:-0}" != "1" ]; then
  log "validating LLM configuration"
  DSH_HOME=/tmp/preflight node /app/auth/render-config.mjs
  rm -rf /tmp/preflight
else
  log "DSH_SKIP_CONFIG_RENDER=1; skipping configuration validation"
fi

if [ -d /data/overlays ]; then
  count=$(find /data/overlays -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | wc -l)
  [ "$count" -gt 0 ] && log "found ${count} cordis overlay(s) in /data/overlays"
fi

# ── run ─────────────────────────────────────────────────────────────────────
log "starting licence gateway on 0.0.0.0:${GATEWAY_PORT}"
log "workspaces are created per licence under ${DSH_WORKSPACE_ROOT}"

node /app/auth/gateway.mjs &
GATEWAY_PID=$!

# ── page-cache pre-warm ─────────────────────────────────────────────────────
# The very first dsh boot in a fresh container reads ~300MB of modules off a
# cold page cache and can take minutes; every subsequent boot is ~7s. Pay that
# once here, in the background, so the first colleague to log in is not the one
# who waits. Best effort: any failure is ignored.
prewarm() {
  local home=/tmp/prewarm-home port=3299 plog=/tmp/prewarm.log
  rm -rf "$home"; mkdir -p "$home"
  DSH_HOME="$home" node /app/auth/render-config.mjs >/dev/null 2>&1 || return 0

  DSH_HOME="$home" node /app/node_modules/@deepseek-ai/dsh/lib/bin.js \
    web --no-open --host 127.0.0.1 --port "$port" >"$plog" 2>&1 &
  local pid=$!
  for _ in $(seq 1 170); do
    grep -q '?token=' "$plog" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$home" "$plog"
  log "pre-warm finished"
}
log "pre-warming module cache in the background"
prewarm &
PREWARM_PID=$!

shutdown() {
  log "shutting down"
  kill "$GATEWAY_PID" "$PREWARM_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

STATUS=0
wait "$GATEWAY_PID" || STATUS=$?
log "gateway exited (status ${STATUS})"
exit "$STATUS"
