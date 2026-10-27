// Valores por defecto SOLO para pruebas locales: las credenciales de desarrollo de platform/compose.yml.
// Cada servicio usa su propio rol y su propia base; nunca las de otro.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '54321';
process.env.DB_NAME ??= 'pay_merchants';
process.env.DB_USER ??= 'pay_merchants';
process.env.DB_PASSWORD ??= 'dev_only_merchants';
// Sin NATS en el arranque de pruebas: los eventos se leen del outbox; el relé hacia NATS se prueba aparte.
process.env.NATS_URL = '';
// Cada prueba usa un esquema propio dentro de la base de ESTE servicio (su rol es dueño de ella).
process.env.PAY_TEST_DATABASE_URL ??= 'postgres://pay_merchants:dev_only_merchants@127.0.0.1:54321/pay_merchants';
// Pruebas: sin barrido periódico (se invoca a mano), KYC acotado para poder probar el tope, y gracia corta de claves.
process.env.DISABLE_BACKGROUND_JOBS ??= '1';
process.env.KYC_MAX_BYTES ??= '4096';
process.env.API_KEY_ROTATION_GRACE_SECONDS ??= '3600';
process.env.KYC_STORE_DIR ??= '/tmp/pay-merchants-test-kyc';
process.env.API_KEY_MAX_ACTIVE ??= '5';
