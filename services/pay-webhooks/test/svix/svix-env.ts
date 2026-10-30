import { createHmac, randomBytes } from 'node:crypto';
import { SvixClient } from '../../src/engine/svix/svix-client';
import { createTestCertificate } from '../tls';
import { HttpsReceiver, RECEIVER_HOST } from '../doubles/https-receiver';

/**
 * Pruebas contra un servidor Svix REAL (svix-server 1.104.0, platform/compose.yml, perfil `full`). Levantalo así (SOLO esos dos servicios):
 *
 *   HUB=mirror.gcr.io SVIX_WHITELIST_NAMES='["receptor.comercio.example"]' SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION=true SVIX_RETRY_SCHEDULE=1,2,3 \
 *     docker compose -f platform/compose.yml --profile full up -d svix-db svix
 *
 * Las tres perillas existen solo para pruebas locales (permiten que Svix entregue a `receptor.comercio.example`, confíe en el certificado
 * autofirmado del receptor y reintente a los 1, 2 y 3 s). Sin ellas `assertSvixReady` falla con este mismo mensaje: no se saltea nada.
 */
export const SVIX_URL = process.env.PAY_TEST_SVIX_URL ?? 'http://127.0.0.1:54800';
/** El `SVIX_JWT_SECRET` de desarrollo de platform/compose.yml. No sirve en ningún entorno real. */
const DEV_JWT_SECRET = process.env.PAY_TEST_SVIX_JWT_SECRET ?? 'dev-only-change-me';

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** JWT HS256 como el que emite `svix-server jwt generate`. Cada corrida usa su PROPIA organización de Svix: no comparte mensajes ni tipos con otra. */
export function svixToken(org = `org_paytest${randomBytes(8).toString('hex')}`, secret = DEV_JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iat: now, exp: now + 6 * 3600, nbf: now, iss: 'svix-server', sub: org }));
  return `${head}.${claims}.${b64url(createHmac('sha256', secret).update(`${head}.${claims}`).digest())}`;
}

export function newSvixClient(token: string, overrides: Partial<ConstructorParameters<typeof SvixClient>[0]> = {}): SvixClient {
  return new SvixClient({ baseUrl: SVIX_URL, authToken: token, timeoutMs: 5_000, maxAttempts: 4, sleep: async () => undefined, ...overrides });
}

export async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000, stepMs = 100): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (accept(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`No se cumplió en ${timeoutMs} ms; último valor: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * Comprueba de punta a punta que el Svix de este entorno sirve para las pruebas: responde, y entrega una petición firmada al receptor HTTPS
 * del anfitrión. Si no, falla con instrucciones (no se saltea: un verde sin Svix no probaría nada).
 */
export async function assertSvixReady(client: SvixClient): Promise<void> {
  const certificate = createTestCertificate(RECEIVER_HOST);
  const receiver = await new HttpsReceiver({}, certificate).listen();
  const app = `mc_canary${randomBytes(4).toString('hex')}`;
  try {
    await client.ensureApp(app, app);
    await client.ensureEventType('canary.ping', 'Canario de las pruebas');
    await client.createEndpoint(app, { uid: 'we_canary0000000', url: receiver.url, eventTypes: ['canary.ping'], secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oDC2FVsBQIhrs=' });
    await client.createMessage(app, { eventId: `canary-${randomBytes(6).toString('hex')}`, eventType: 'canary.ping', payload: { ok: true } });
    await eventually(async () => receiver.requests.length, (n) => n > 0, 10_000);
    const names = Object.keys(receiver.requests[0].headers).filter((h) => h.startsWith('webhook-') || h.startsWith('svix-'));
    if (!names.includes('webhook-id')) throw new Error(`Svix entrega cabeceras ${names.join(',')}: falta SVIX_WHITELABEL_HEADERS=true (compose.yml)`);
  } catch (error) {
    throw new Error(`El Svix de ${SVIX_URL} no está listo para las pruebas (${error instanceof Error ? error.message : 'error'}). Ver el comentario de test/svix/svix-env.ts.`);
  } finally {
    await receiver.close();
    certificate.dispose();
  }
}
