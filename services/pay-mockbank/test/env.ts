// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_mockbank';
process.env.DB_USER ??= 'pay_mockbank';
process.env.DB_PASSWORD ??= 'dev_only_mockbank';
process.env.PAY_MODE ??= 'sandbox';
// [DEV] Secreto SINTÉTICO con el que el banco simulado firma sus callbacks: el MISMO que verifica el conector `mock` de pay-connectors en sandbox.
process.env.MOCKBANK_WEBHOOK_SECRET ??= 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==';
// Las pruebas disparan la entrega a mano (`POST /sandbox/admin/deliver`); ningún temporizador corre solo.
process.env.MOCKBANK_DELIVERY_INTERVAL_MS ??= '0';
