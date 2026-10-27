#!/bin/sh
# Crea UN rol y UNA base por servicio, sin permisos cruzados (regla de separación #1 del plan maestro).
# Credenciales SOLO de desarrollo local. Producción las toma de OpenBao / Coolify, nunca de este archivo.
set -eu
for svc in edge payments connectors qr ledger settlement merchants risk schedules; do
  role="pay_${svc}"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<SQL
CREATE ROLE ${role} LOGIN PASSWORD 'dev_only_${svc}';
CREATE DATABASE ${role} OWNER ${role};
REVOKE ALL ON DATABASE ${role} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${role} TO ${role};
SQL
done
# Base compartida SOLO para las pruebas de integración (@pay/testing); cada prueba usa su propio esquema.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE pay_test" -c "REVOKE ALL ON DATABASE pay_test FROM PUBLIC"
# Los roles de servicio no entran a la base de mantenimiento.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "REVOKE ALL ON DATABASE postgres FROM PUBLIC"
