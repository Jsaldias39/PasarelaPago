// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_connectors';
process.env.DB_USER ??= 'pay_connectors';
process.env.DB_PASSWORD ??= 'dev_only_connectors';
process.env.NATS_URL ??= 'nats://127.0.0.1:54222';
process.env.PAY_MODE ??= 'sandbox';
// Las pruebas disparan el simulador y el poller a mano; ningún temporizador corre solo.
process.env.MOCK_PUMP_INTERVAL_MS ??= '0';
process.env.POLLER_INTERVAL_MS ??= '0';
process.env.HEALTH_INTERVAL_MS ??= '0';
// [DEV] secreto del simulador (Standard Webhooks). Solo vale para el conector `mock`; en producción lo entrega OpenBao.
process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET ??= 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==';
process.env.RECONCILE_INTERVAL_MS ??= '0';
// BANK_TRANSFER_* no se fijan acá: en sandbox toman el valor sintético declarado (SANDBOX_BANK_ACCOUNT).
// OpenBao de DESARROLLO (platform/compose.yml, perfil full: `HUB=mirror.gcr.io docker compose -f platform/compose.yml --profile full up -d openbao`). El token raíz
// es el de `-dev-root-token-id` y SOLO sirve en ese servidor descartable (en memoria); lo usan únicamente las pruebas para crear su montaje, políticas y tokens.
process.env.PAY_TEST_OPENBAO_ADDR ??= 'http://127.0.0.1:54200';
process.env.PAY_TEST_OPENBAO_ROOT_TOKEN ??= 'dev-only-root';
