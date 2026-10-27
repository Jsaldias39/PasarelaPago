// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_vault';
process.env.DB_USER ??= 'pay_vault';
process.env.DB_PASSWORD ??= 'dev_only_vault';
process.env.NATS_URL ??= 'nats://127.0.0.1:54222';
process.env.VAULT_BACKEND ??= 'fake';
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_vault:dev_only_vault@127.0.0.1:54321/pay_vault';
