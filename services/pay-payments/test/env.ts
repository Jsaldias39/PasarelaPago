// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_payments';
process.env.DB_USER ??= 'pay_payments';
process.env.DB_PASSWORD ??= 'dev_only_payments';
process.env.NATS_URL ??= 'nats://127.0.0.1:54222';
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_payments:dev_only_payments@127.0.0.1:54321/pay_payments';
// Servicios aguas arriba: puertos cerrados a propósito. Las pruebas que los necesitan levantan dobles y sobrescriben estas URL.
process.env.RISK_URL ??= 'http://127.0.0.1:1';
process.env.CONNECTORS_URL ??= 'http://127.0.0.1:1';
process.env.LEDGER_URL ??= 'http://127.0.0.1:1';
// El arranque de salud no necesita Temporal; las pruebas de workflows levantan su propio worker.
process.env.TEMPORAL_RUN_WORKER ??= 'false';
