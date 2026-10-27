// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_risk';
process.env.DB_USER ??= 'pay_risk';
process.env.DB_PASSWORD ??= 'dev_only_risk';
// Sin NATS en las pruebas: este servicio no publica eventos (no hay riesgo en el AsyncAPI).
process.env.NATS_URL = '';
// Cada prueba usa un esquema propio dentro de la base de ESTE servicio (su rol es dueño de ella).
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_risk:dev_only_risk@127.0.0.1:54321/pay_risk';
// Watchman v2-static (listas de 2019, SOLO sandbox) del stack local.
process.env.WATCHMAN_URL ??= 'http://127.0.0.1:54084';
// UMBRALES DE PRUEBA: no son valores de negocio. Los de producción los fija cumplimiento y no tienen valor por defecto.
process.env.SANCTIONS_DENY_SCORE ??= '0.80';
process.env.SANCTIONS_REVIEW_SCORE ??= '0.60';
process.env.PAYER_HASH_KEY ??= 'clave-de-prueba-no-es-un-secreto';
