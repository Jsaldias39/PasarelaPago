#!/usr/bin/env bash
# TigerBeetle local para el desarrollo y las pruebas de pay-ledger (la imagen de ghcr.io no siempre baja; el binario sí).
# Uso: platform/scripts/tigerbeetle-dev.sh start|stop|status|reset
# Modo PRODUCCIÓN de la réplica (sin --development), como en el spike: 1 réplica, cluster 0, puerto 54300.
# SOLO desarrollo: una réplica no tolera la caída del nodo. Datos en .tools/tigerbeetle/ (ignorado por git).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR="$ROOT/.tools/tigerbeetle"; BIN="$DIR/tigerbeetle"; DATA="$DIR/0_0.tigerbeetle"; PIDFILE="$DIR/tb.pid"; LOG="$DIR/tb.log"
ADDR=${TB_ADDRESS:-127.0.0.1:54300}
URL="https://github.com/tigerbeetle/tigerbeetle/releases/latest/download/tigerbeetle-x86_64-linux.zip"
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "${1:-status}" in
  start)
    mkdir -p "$DIR"
    if [ ! -x "$BIN" ]; then
      if [ -f /tmp/tb/tb.zip ]; then cp /tmp/tb/tb.zip "$DIR/tb.zip"; else curl -fsSL --max-time 120 -o "$DIR/tb.zip" "$URL"; fi
      (cd "$DIR" && unzip -oq tb.zip && chmod +x tigerbeetle && rm -f tb.zip)
    fi
    running && { echo "tigerbeetle ya está corriendo (pid $(cat "$PIDFILE")) en $ADDR"; exit 0; }
    [ -f "$DATA" ] || "$BIN" format --cluster=0 --replica=0 --replica-count=1 "$DATA" >/dev/null
    nohup "$BIN" start --addresses="$ADDR" "$DATA" >"$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 40); do (exec 3<>/dev/tcp/"${ADDR%:*}"/"${ADDR#*:}") 2>/dev/null && { echo "tigerbeetle $("$BIN" version) escuchando en $ADDR (pid $(cat "$PIDFILE"))"; exit 0; }; sleep 0.5; done
    echo "tigerbeetle no abrió el puerto; ver $LOG" >&2; exit 1 ;;
  stop) if running; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo "detenido"; else echo "no estaba corriendo"; fi ;;
  reset) "$0" stop; rm -f "$DATA"; echo "datos borrados" ;;
  status) if running; then echo "corriendo (pid $(cat "$PIDFILE")) en $ADDR"; else echo "detenido"; fi ;;
  *) echo "uso: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
