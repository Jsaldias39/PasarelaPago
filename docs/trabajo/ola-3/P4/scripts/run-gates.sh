#!/bin/bash
R=/home/user/pasarelapago
EV=$R/docs/trabajo/ola-3/P4/evidencia
SC=$R/docs/trabajo/ola-3/P4/scripts
rm -f /tmp/p4-ola3.done
runit() { # nombre svc comando...
  name=$1; svc=$2; shift 2
  { echo "# $name"; echo "\$ (cd services/$svc && $*)"; echo "(las líneas JSON de pino de las pruebas se omiten; todo lo demás es literal)"; echo; out=$(cd $R/services/$svc && "$@" 2>&1; echo "__EXIT=$?"); echo "$out" | grep -v '^__EXIT' | grep -v '^{"level"'; echo "exit=${out##*__EXIT=}"; } > $EV/$name.txt
  grep -E "^Tests:|^exit" $EV/$name.txt | tr '\n' ' '; echo " <- $name"
}
script() { # nombre comando...
  name=$1; shift
  { echo "# $name"; echo "\$ $*"; echo; out=$(cd $R && "$@" 2>&1; echo "__EXIT=$?"); echo "$out" | grep -v '^__EXIT'; echo "exit=${out##*__EXIT=}"; } > $EV/$name.txt
  grep -E "^exit|RESULTADO" $EV/$name.txt | tr '\n' ' '; echo " <- $name"
}
export PAY_TEST_DATABASE_URL=postgres://pay_mockbank:dev_only_mockbank@127.0.0.1:54321/pay_mockbank
runit 3c-qr-typecheck pay-qr yarn typecheck
runit 3c-qr-build pay-qr yarn build
runit 3c-mockbank-typecheck pay-mockbank yarn typecheck
runit 3c-mockbank-build pay-mockbank yarn build
runit 3c-pool-error-mockbank pay-mockbank yarn test --maxWorkers=2 --verbose test/pool-error.spec.ts
runit 3c-mockbank-test-1 pay-mockbank yarn test --maxWorkers=2
runit 3c-mockbank-test-2 pay-mockbank yarn test --maxWorkers=2
runit 3a-idempotencia-mockbank pay-mockbank yarn test --maxWorkers=2 --verbose test/idempotency-parallel.spec.ts
runit 3a-fallos-mockbank pay-mockbank yarn test --maxWorkers=2 --verbose test/faults.spec.ts
export PAY_TEST_DATABASE_URL=postgres://pay_connectors:dev_only_connectors@127.0.0.1:54321/pay_connectors
runit 3c-connectors-typecheck pay-connectors yarn typecheck
runit 3c-connectors-build pay-connectors yarn build
runit 3c-pool-error-connectors pay-connectors yarn test --maxWorkers=2 --verbose test/pool-error.spec.ts
runit 3c-connectors-test-1 pay-connectors yarn test --maxWorkers=2
runit 3c-connectors-test-2 pay-connectors yarn test --maxWorkers=2
runit 3b-drift-connectors pay-connectors yarn test --maxWorkers=2 --verbose test/drift.spec.ts
runit 3c-money-guards-connectors pay-connectors yarn test --maxWorkers=2 --verbose test/money-guards.spec.ts
runit 3c-concurrencia-connectors pay-connectors yarn test --maxWorkers=2 --verbose test/send-lock.spec.ts test/charges.spec.ts test/transfers.spec.ts -t "simultáne|corrida|candado|withSendLock|conexiones"
runit 3a-fallos-connectors pay-connectors yarn test --maxWorkers=2 --verbose test/db-down.spec.ts test/infra-faults.spec.ts
runit 3a-sandbox-header-connectors pay-connectors yarn test --maxWorkers=2 --verbose test/sandbox-header.spec.ts
CONNECTOR=mock; export CONNECTOR; runit 3a-contrato-mock pay-connectors yarn test:contract --maxWorkers=2; unset CONNECTOR
export PAY_TEST_DATABASE_URL=postgres://pay_qr:dev_only_qr@127.0.0.1:54321/pay_qr
runit 3c-pool-error-qr pay-qr yarn test --maxWorkers=2 --verbose test/pool-error.spec.ts
runit 3c-qr-test-1 pay-qr yarn test --maxWorkers=2
runit 3c-qr-test-2 pay-qr yarn test --maxWorkers=2
runit 3b-drift-qr pay-qr yarn test --maxWorkers=2 --verbose test/drift.spec.ts
runit 3a-fallos-qr pay-qr yarn test --maxWorkers=2 --verbose test/faults.spec.ts
runit 3a-sandbox-header-qr pay-qr yarn test --maxWorkers=2 --verbose test/sandbox-header.spec.ts
runit 3a-idempotencia-qr pay-qr yarn test --maxWorkers=2 --verbose test/qr.spec.ts -t "simultáneos"
unset PAY_TEST_DATABASE_URL
script 3b-vendor-check-connectors services/pay-connectors/scripts/vendor-ddl.sh --check
script 3b-vendor-check-qr services/pay-qr/scripts/vendor-ddl.sh --check
script 3a-separacion bash docs/trabajo/ola-3/P4/scripts/gate-separation.sh
script 3a-datos-sensibles node docs/trabajo/ola-3/P4/scripts/sensitive-data-scan.mjs
script 3a-docker bash docs/trabajo/ola-3/P4/scripts/gate-docker.sh
script 3a-eslint-servicios yarn eslint services/pay-mockbank services/pay-connectors services/pay-qr
script 3a-yarn-lint yarn lint
touch /tmp/p4-ola3.done
