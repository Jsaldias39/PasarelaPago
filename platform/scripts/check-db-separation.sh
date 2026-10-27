#!/usr/bin/env bash
# Regla de separación #1 (REQ-P1-7): cada servicio solo entra a SU base.
# Para cada par (rol A, base B): A debe poder entrar a su base y NO a la de los demás.
# Uso: platform/scripts/check-db-separation.sh [host] [puerto]
set -uo pipefail
HOST=${1:-127.0.0.1}; PORT=${2:-54321}
services=(edge payments connectors qr ledger settlement merchants risk schedules webhooks vault mockbank)
ok=0; bad=0
for a in "${services[@]}"; do
  for b in "${services[@]}"; do
    out=$(PGPASSWORD="dev_only_${a}" psql -h "$HOST" -p "$PORT" -U "pay_${a}" -d "pay_${b}" -tAc "select 1" 2>&1); rc=$?
    if [ "$a" = "$b" ]; then
      if [ $rc -eq 0 ]; then ok=$((ok+1)); else echo "FALLA: pay_${a} no entra a su propia base: $out"; bad=$((bad+1)); fi
    else
      if [ $rc -ne 0 ] && echo "$out" | grep -q "permission denied"; then ok=$((ok+1)); else echo "FALLA: pay_${a} entró (o falló por otra causa) en pay_${b}: $out"; bad=$((bad+1)); fi
    fi
  done
  # tampoco a la base de mantenimiento ni a la de pruebas
  for other in postgres pay_test; do
    out=$(PGPASSWORD="dev_only_${a}" psql -h "$HOST" -p "$PORT" -U "pay_${a}" -d "$other" -tAc "select 1" 2>&1); rc=$?
    if [ $rc -ne 0 ] && echo "$out" | grep -q "permission denied"; then ok=$((ok+1)); else echo "FALLA: pay_${a} entró a ${other}: $out"; bad=$((bad+1)); fi
  done
done
echo "separación: ${ok} comprobaciones correctas, ${bad} fallas"
[ "$bad" -eq 0 ]
