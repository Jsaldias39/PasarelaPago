#!/bin/sh
# Crea UN rol y UNA base por servicio, sin permisos cruzados (regla de separación #1 del plan maestro).
# Credenciales SOLO de desarrollo local. Producción las toma de OpenBao / Coolify, nunca de este archivo.
set -eu
for svc in edge payments connectors qr ledger settlement merchants risk schedules webhooks vault mockbank; do
  role="pay_${svc}"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<SQL
CREATE ROLE ${role} LOGIN PASSWORD 'dev_only_${svc}';
CREATE DATABASE ${role} OWNER ${role};
REVOKE ALL ON DATABASE ${role} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${role} TO ${role};
-- Y por rol, explícito: ningún rol de servicio abre template1 (hoy no tiene un GRANT directo, pero el REVOKE deja escrita la intención y sobrevive a un GRANT futuro).
REVOKE ALL ON DATABASE template1 FROM ${role};
SQL
done
# Base compartida SOLO para las pruebas de integración (@pay/testing); cada prueba usa su propio esquema.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE pay_test" -c "REVOKE ALL ON DATABASE pay_test FROM PUBLIC"
# Los roles de servicio no entran a la base de mantenimiento.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "REVOKE ALL ON DATABASE postgres FROM PUBLIC"
# template1 viene con CONNECT para PUBLIC: cualquier rol de servicio lo abría (gate de Separación, hallazgo de P2). No guarda datos de negocio, pero el gate pide
# «sin permisos sobre las demás bases». Revocar CONNECT no impide crear bases a partir de ella (eso lo hace el superusuario o quien tenga CREATEDB, sin conectarse).
# template0 ya no acepta conexiones por defecto. Comprobación: platform/scripts/check-db-separation.sh con CHECK_TEMPLATE1=1.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "REVOKE ALL ON DATABASE template1 FROM PUBLIC"
