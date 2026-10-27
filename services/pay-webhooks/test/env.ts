// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_webhooks';
process.env.DB_USER ??= 'pay_webhooks';
process.env.DB_PASSWORD ??= 'dev_only_webhooks';
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_webhooks:dev_only_webhooks@127.0.0.1:54321/pay_webhooks';
process.env.PAY_MODE ??= 'sandbox';
// Clave de sellado SOLO de pruebas (32 bytes fijos): no sirve en ningún entorno real.
process.env.WEBHOOKS_SECRET_KEK ??= Buffer.alloc(32, 7).toString('base64');
// Sin NATS_URL a propósito: la lectura de eventos se prueba con su propia configuración (test/events.spec.ts).
process.env.WEBHOOKS_WORKER_ENABLED ??= 'false';
