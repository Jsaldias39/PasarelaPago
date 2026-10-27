import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { isPublicIp } from '../src/ssrf/ip-policy';
import { HttpsTransport, TransportError } from '../src/ssrf/https-transport';
import { TargetGuard, TargetRejectedError, type Resolver } from '../src/ssrf/target-guard';
import { createTestCertificate, type TestCertificate } from './tls';

/** P1.H3.M6 — entrega a salvo de SSRF. Resolver y transporte son los puntos de inyección; el resto es código real. */
class FakeResolver implements Resolver {
  readonly calls: string[] = [];
  constructor(private readonly table: Record<string, readonly string[] | Error | (() => readonly string[])>) {}
  async resolve(hostname: string): Promise<readonly string[]> {
    this.calls.push(hostname);
    const entry = this.table[hostname];
    if (entry === undefined) throw new Error('ENOTFOUND');
    if (entry instanceof Error) throw entry;
    return typeof entry === 'function' ? entry() : entry;
  }
}

const reason = async (guard: TargetGuard, url: string) => {
  try {
    await guard.check(url);
    return 'ACEPTADA';
  } catch (error) {
    if (error instanceof TargetRejectedError) return error.reason;
    throw error;
  }
};

describe('isPublicIp — rangos', () => {
  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '192.0.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e', '2400:cb00::1',
  ])('%s es pública', (ip) => expect(isPublicIp(ip)).toBe(true));

  it.each([
    // límites exactos de cada rango bloqueado (primer y último valor)
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.1', '127.255.255.255', '169.254.169.254', '169.254.0.0', '169.254.255.255',
    '172.16.0.0', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.0.1', '192.168.255.255', '198.18.0.0', '198.19.255.255', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    // IPv6
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '100::1', '1::1',
  ])('%s NO es pública', (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(['', 'hola', '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4x', '::g', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '2606:4700::1::1'])('lo que no se puede interpretar (%p) se trata como NO pública', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it('IPv4 mapeada a IPv6 con una pública SÍ es pública (se evalúa la IPv4 que lleva)', () => {
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicIp('64:ff9b::808:808')).toBe(true);
  });
});

describe('TargetGuard — registrar y entregar', () => {
  const resolver = new FakeResolver({
    'api.comercio.example': ['93.184.216.34'],
    'dual.example': ['93.184.216.34', '2606:4700:4700::1111'],
    'mixto.example': ['93.184.216.34', '10.0.0.5'],
    'privado.example': ['10.1.2.3'],
    'metadatos.example': ['169.254.169.254'],
    'loopback.example': ['127.0.0.1'],
    'loopback6.example': ['::1'],
    'mapeado.example': ['::ffff:127.0.0.1'],
    'vacio.example': [],
    'roto.example': new Error('SERVFAIL'),
  });
  const guard = new TargetGuard(resolver);

  it('nivel CORRECTO: una URL pública resuelve a una IP pública y queda fijada', async () => {
    const target = await guard.check('https://api.comercio.example/webhooks/pay?v=1');
    expect(target).toEqual({ hostname: 'api.comercio.example', port: 443, path: '/webhooks/pay?v=1', ip: '93.184.216.34', family: 4 });
    expect((await guard.check('https://dual.example/')).ip).toBe('93.184.216.34');
    expect((await guard.check('https://93.184.216.34/h')).family).toBe(4);
    expect((await guard.check('https://[2606:4700:4700::1111]/h')).family).toBe(6);
  });

  it.each([
    ['loopback IPv4', 'https://127.0.0.1/h'],
    ['loopback decimal', 'https://2130706433/h'],
    ['loopback hexadecimal', 'https://0x7f000001/h'],
    ['loopback octal', 'https://0177.0.0.1/h'],
    ['loopback abreviado', 'https://127.1/h'],
    ['0.0.0.0', 'https://0.0.0.0/h'],
    ['metadatos de nube', 'https://169.254.169.254/latest/meta-data/'],
    ['metadatos en decimal', 'https://2852039166/latest/meta-data/'],
    ['10.x', 'https://10.0.0.8/h'],
    ['172.16.x', 'https://172.16.5.5/h'],
    ['192.168.x', 'https://192.168.1.1/h'],
    ['CGNAT', 'https://100.64.0.1/h'],
    ['loopback IPv6', 'https://[::1]/h'],
    ['IPv4 mapeada a loopback', 'https://[::ffff:7f00:1]/h'],
    ['IPv4 mapeada a metadatos', 'https://[::ffff:169.254.169.254]/h'],
    ['ULA', 'https://[fd00::1]/h'],
    ['link-local IPv6', 'https://[fe80::1]/h'],
  ])('nivel INVÁLIDO — IP literal: %s ⇒ private_address', async (_name, url) => {
    expect(await reason(guard, url)).toBe('private_address');
  });

  it.each([
    'https://localhost/h', 'https://LOCALHOST./h', 'https://pay-ledger/h', 'https://pay-vault:443/h', 'https://postgres/h', 'https://redis/h',
    'https://app.localhost/h', 'https://impresora.local/h', 'https://wiki.internal/h', 'https://pay-ledger.svc/h', 'https://pay-ledger.pay.svc.cluster.local/h', 'https://nas.lan/h', 'https://router.home.arpa/h',
  ])('nivel INVÁLIDO — nombre interno %s ⇒ internal_name, SIN resolver', async (url) => {
    const before = resolver.calls.length;
    expect(await reason(guard, url)).toBe('internal_name');
    expect(resolver.calls).toHaveLength(before);
  });

  it.each([
    ['privado.example', 'private_address'],
    ['metadatos.example', 'private_address'],
    ['loopback.example', 'private_address'],
    ['loopback6.example', 'private_address'],
    ['mapeado.example', 'private_address'],
    ['mixto.example', 'private_address'],
    ['vacio.example', 'unresolvable'],
    ['roto.example', 'unresolvable'],
    ['no-existe.example', 'unresolvable'],
  ])('nivel INVÁLIDO — un nombre que resuelve a %s ⇒ %s (basta UNA dirección privada)', async (host, expected) => {
    expect(await reason(guard, `https://${host}/h`)).toBe(expected);
  });

  it.each([
    ['http://api.comercio.example/h', 'https_required'],
    ['ftp://api.comercio.example/h', 'https_required'],
    ['gopher://api.comercio.example/h', 'https_required'],
    ['file:///etc/passwd', 'https_required'],
    ['javascript:alert(1)', 'https_required'],
    ['https://usuario:clave@api.comercio.example/h', 'credentials_in_url'],
    ['https://usuario@api.comercio.example/h', 'credentials_in_url'],
    ['https://api.comercio.example:8443/h', 'port_not_allowed'],
    ['https://api.comercio.example:22/h', 'port_not_allowed'],
    ['https://api.comercio.example:5432/h', 'port_not_allowed'],
    ['', 'invalid_url'],
    ['no es una url', 'invalid_url'],
    ['//api.comercio.example/h', 'invalid_url'],
    ['https://', 'invalid_url'],
  ])('nivel INVÁLIDO — %p ⇒ %s', async (url, expected) => {
    expect(await reason(guard, url)).toBe(expected);
  });

  it('nivel LÍMITE — el puerto 443 explícito pasa; el punto final del nombre se ignora', async () => {
    expect(await reason(guard, 'https://api.comercio.example:443/h')).toBe('ACEPTADA');
    expect(await reason(guard, 'https://api.comercio.example./h')).toBe('ACEPTADA');
  });

  it('DNS REBINDING: pública al registrar, privada al entregar ⇒ la segunda comprobación la rechaza', async () => {
    let answer: readonly string[] = ['93.184.216.34'];
    const rebinding = new TargetGuard(new FakeResolver({ 'cambiante.example': () => answer }));
    expect(await reason(rebinding, 'https://cambiante.example/h')).toBe('ACEPTADA'); // alta
    answer = ['10.0.0.5'];
    expect(await reason(rebinding, 'https://cambiante.example/h')).toBe('private_address'); // entrega
    answer = ['169.254.169.254'];
    expect(await reason(rebinding, 'https://cambiante.example/h')).toBe('private_address');
  });

  it('el resultado no depende de mayúsculas ni de IDN: la IP fijada es la que se validó', async () => {
    const target = await guard.check('https://API.Comercio.Example/h');
    expect(target.hostname).toBe('api.comercio.example');
  });
});

describe('HttpsTransport — conexión real fijada a la IP validada', () => {
  let cert: TestCertificate;
  let server: Server;
  let port: number;
  const seen: { host: string | undefined; body: string; sni: string | false | undefined }[] = [];
  let mode: 'ok' | 'redirect' | 'hang' | 'big' = 'ok';
  const transport = () => new HttpsTransport({ ca: cert.cert });
  const target = (overrides: Partial<{ hostname: string; port: number; ip: string }> = {}) => ({ hostname: 'receiver.test', port, path: '/hook?x=1', ip: '127.0.0.1', family: 4 as const, ...overrides });

  beforeAll(async () => {
    cert = createTestCertificate('receiver.test');
    server = createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ host: req.headers.host, body: Buffer.concat(chunks).toString('utf8'), sni: (req.socket as unknown as { servername?: string }).servername });
        if (mode === 'hang') return;
        if (mode === 'redirect') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          return void res.end();
        }
        if (mode === 'big') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return void res.end(Buffer.alloc(1024 * 1024, 97));
        }
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cert.dispose();
  });
  beforeEach(() => {
    seen.length = 0;
    mode = 'ok';
  });

  it('nivel CORRECTO: entrega a la IP fijada (el nombre NO existe en DNS), con SNI, Host y bytes exactos', async () => {
    const body = '{ "b" : 2,\n"ñandú":"✓" }';
    const res = await transport().send({ target: target(), headers: { 'content-type': 'application/json', 'webhook-id': 'evt_1' }, body, timeoutMs: 3000 });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].host).toBe(`receiver.test:${port}`);
    expect(seen[0].sni).toBe('receiver.test');
    expect(seen[0].body).toBe(body);
  });

  it('nivel INVÁLIDO: el certificado debe corresponder al nombre ⇒ tls_error y nada se envía', async () => {
    await expect(transport().send({ target: target({ hostname: 'otro.test' }), headers: {}, body: '{}', timeoutMs: 3000 })).rejects.toMatchObject({ name: 'TransportError', reason: 'tls_error' });
    expect(seen).toHaveLength(0);
  });

  it('nivel INVÁLIDO: sin la CA de confianza (producción) un certificado autofirmado se rechaza', async () => {
    await expect(new HttpsTransport().send({ target: target(), headers: {}, body: '{}', timeoutMs: 3000 })).rejects.toMatchObject({ reason: 'tls_error' });
    expect(seen).toHaveLength(0);
  });

  it('NO sigue redirecciones: un 302 hacia los metadatos de nube se devuelve como 302 y hubo UNA sola petición', async () => {
    mode = 'redirect';
    const res = await transport().send({ target: target(), headers: {}, body: '{}', timeoutMs: 3000 });
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it('nivel LÍMITE: un servidor que no responde da timeout dentro del plazo', async () => {
    mode = 'hang';
    const started = Date.now();
    await expect(transport().send({ target: target(), headers: {}, body: '{}', timeoutMs: 300 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('nivel LÍMITE: una respuesta enorme se corta (response_too_large)', async () => {
    mode = 'big';
    await expect(transport().send({ target: target(), headers: {}, body: '{}', timeoutMs: 3000 })).rejects.toMatchObject({ reason: 'response_too_large' });
  });

  it('nivel INVÁLIDO: un puerto cerrado da connection_error sin filtrar la dirección', async () => {
    const error = await transport().send({ target: target({ port: 1 }), headers: {}, body: '{}', timeoutMs: 3000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).reason).toBe('connection_error');
    expect((error as TransportError).message).not.toMatch(/127\.0\.0\.1/);
  });
});
