#!/bin/bash
set -e

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
ROOT_DIR="$(dirname "$DIR")"
SRC_FILE="$ROOT_DIR/src/index.ts"
VERSION="0.1.0"

STATE_DIR="${GEMINI_GATEWAY_STATE_DIR:-$HOME/.claude-gemini-gateway}"
mkdir -p "$STATE_DIR"
PID_FILE="$STATE_DIR/gateway.pid"
LOG_FILE="$STATE_DIR/gateway.log"
BUN_BIN="$(command -v bun || echo bun)"
PORT="${GEMINI_GATEWAY_PORT:-4141}"

case "$1" in
  start)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p $PID > /dev/null 2>&1; then
        echo "Gemini gateway is already running (pid $PID)."
        exit 0
      else
        echo "Removing stale pid file."
        rm -f "$PID_FILE"
      fi
    fi
    echo "Starting Gemini gateway on port $PORT..."
    nohup "$BUN_BIN" "$SRC_FILE" serve > "$LOG_FILE" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"
    echo "Gemini gateway started (pid $PID)."
    ;;
  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "Gemini gateway is not running."
      exit 0
    fi
    PID=$(cat "$PID_FILE")
    if ps -p $PID > /dev/null 2>&1; then
      echo "Stopping Gemini gateway (pid $PID)..."
      kill $PID 2>/dev/null || true
    else
      echo "Gemini gateway is not running (stale pid)."
    fi
    rm -f "$PID_FILE"
    echo "Gemini gateway stopped."
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p $PID > /dev/null 2>&1; then
        echo "Gemini gateway is running (pid $PID, port $PORT)."
        exit 0
      else
        echo "Gemini gateway is not running (stale pid file)."
        rm -f "$PID_FILE"
        exit 1
      fi
    else
      echo "Gemini gateway is not running."
      exit 1
    fi
    ;;
  doctor)
    echo "Checking Gemini gateway environment..."
    if ! command -v bun >/dev/null 2>&1; then
      echo "❌ bun is not installed or not in PATH."
      exit 1
    fi
    "$BUN_BIN" "$SRC_FILE" doctor
    ;;
  version)
    echo "claude-gemini-gateway v$VERSION"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|doctor|version}"
    exit 1
    ;;
esac
