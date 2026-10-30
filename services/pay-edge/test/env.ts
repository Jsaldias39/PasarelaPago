// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// pay-edge usa su propio rol y su propia base; nunca las de otro servicio.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_edge';
process.env.DB_USER ??= 'pay_edge';
process.env.DB_PASSWORD ??= 'dev_only_edge';
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_edge:dev_only_edge@127.0.0.1:54321/pay_edge';
process.env.PAY_MODE ??= 'sandbox';
process.env.REDIS_URL ??= 'redis://127.0.0.1:54379';
// Destinos de relleno: las pruebas que reenvían levantan sus dobles y los reemplazan.
for (const name of ['PAY_PAYMENTS', 'PAY_MERCHANTS', 'PAY_SCHEDULES', 'PAY_WEBHOOKS', 'PAY_LEDGER', 'PAY_SETTLEMENT']) process.env[`UPSTREAM_${name}_URL`] ??= 'http://127.0.0.1:1';
// Sin NATS_URL a propósito: la réplica de eventos se prueba con su propia configuración (test/replica.spec.ts).
