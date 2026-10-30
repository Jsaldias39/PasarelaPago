import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { RateLimiter } from '../src/rate-limiter';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:54379';
let redis: Redis;
beforeAll(() => {
  redis = new Redis(REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});

const limiter = (windowSeconds = 60) => new RateLimiter(redis, `t:${randomBytes(4).toString('hex')}`, windowSeconds);

describe('RateLimiter (Redis real)', () => {
  it('deja pasar hasta el límite y limita el siguiente, con Retry-After de la ventana', async () => {
    const l = limiter();
    for (let i = 1; i <= 3; i += 1) expect(await l.hit('k', 3)).toMatchObject({ status: 'ok', count: i });
    const over = await l.hit('k', 3);
    expect(over).toMatchObject({ status: 'limited', count: 4, limit: 3 });
    expect(over.status === 'limited' && over.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(over.status === 'limited' && over.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('claves distintas no se pisan', async () => {
    const l = limiter();
    await l.hit('a', 1);
    expect((await l.hit('a', 1)).status).toBe('limited');
    expect((await l.hit('b', 1)).status).toBe('ok');
  });

  it('100 pedidos concurrentes con límite 20: pasan EXACTAMENTE 20', async () => {
    const l = limiter();
    const decisions = await Promise.all(Array.from({ length: 100 }, () => l.hit('burst', 20)));
    expect(decisions.filter((d) => d.status === 'ok')).toHaveLength(20);
    expect(decisions.filter((d) => d.status === 'limited')).toHaveLength(80);
  });

  it('la ventana vence sola y el contador vuelve a empezar', async () => {
    const l = limiter(1);
    expect((await l.hit('w', 1)).status).toBe('ok');
    expect((await l.hit('w', 1)).status).toBe('limited');
    const deadline = Date.now() + 5_000;
    let decision = await l.hit('w', 1);
    while (decision.status === 'limited' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      decision = await l.hit('w', 1);
    }
    expect(decision).toMatchObject({ status: 'ok', count: 1 });
  });

  it('una clave que quedó SIN vencimiento (INCR sin EXPIRE) se repara en vez de limitar para siempre', async () => {
    const prefix = `t:${randomBytes(4).toString('hex')}`;
    await redis.set(`${prefix}:orphan`, '7'); // sin TTL: lo que dejaría una caída entre INCR y EXPIRE
    expect(await redis.ttl(`${prefix}:orphan`)).toBe(-1);
    const l = new RateLimiter(redis, prefix, 30);
    await l.hit('orphan', 100);
    const ttl = await redis.ttl(`${prefix}:orphan`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('peek cuenta sin sumar', async () => {
    const l = limiter();
    expect(await l.peek('p')).toBe(0);
    await l.hit('p', 10);
    await l.hit('p', 10);
    expect(await l.peek('p')).toBe(2);
    expect(await l.peek('p')).toBe(2);
  });

  it('si Redis no responde devuelve `unavailable` (no lanza) para que el llamador decida', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null, commandTimeout: 200 });
    dead.on('error', () => undefined);
    const l = new RateLimiter(dead, 't:dead', 60);
    expect(await l.hit('x', 1)).toEqual({ status: 'unavailable' });
    expect(await l.peek('x')).toBeNull();
    dead.disconnect();
  });
});
