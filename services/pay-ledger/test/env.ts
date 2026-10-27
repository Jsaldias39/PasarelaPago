// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_ledger';
process.env.DB_USER ??= 'pay_ledger';
process.env.DB_PASSWORD ??= 'dev_only_ledger';
process.env.NATS_URL ??= 'nats://127.0.0.1:54222';
process.env.TB_ADDRESS ??= '127.0.0.1:54300';
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_ledger:dev_only_ledger@127.0.0.1:54321/pay_ledger';
