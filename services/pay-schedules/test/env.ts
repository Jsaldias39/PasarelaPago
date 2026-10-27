// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_schedules';
process.env.DB_USER ??= 'pay_schedules';
process.env.DB_PASSWORD ??= 'dev_only_schedules';
// Sin NATS en las pruebas: los eventos se leen del outbox.
process.env.NATS_URL = '';
// Cada prueba usa un esquema propio dentro de la base de ESTE servicio (su rol es dueño de ella).
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_schedules:dev_only_schedules@127.0.0.1:54321/pay_schedules';
// Libro mayor [DOBLE]: cada prueba arranca el suyo y reemplaza esta URL; esta existe solo para que la configuración cargue.
process.env.LEDGER_URL ??= 'http://127.0.0.1:1';
// POLÍTICA DE PRUEBA, no de negocio: la de producción la fija el negocio y no tiene valor por defecto.
process.env.RETRY_DELAYS_SECONDS ??= '3600,7200,14400';
process.env.DISABLE_BACKGROUND_JOBS ??= '1';
process.env.PAY_MODE ??= 'sandbox';
