import { CircuitBreaker } from '../src/proxy/circuit-breaker';

describe('CircuitBreaker (reloj inyectado)', () => {
  const make = () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(3, 10_000, () => now);
    return { breaker, advance: (ms: number) => (now += ms) };
  };

  it('cerrado deja pasar; se abre con fallos CONSECUTIVOS y un éxito corta la cuenta', () => {
    const { breaker } = make();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('abierto rechaza durante el enfriamiento y dice cuánto falta', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.onFailure();
    advance(4_000);
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.retryAfterMs()).toBe(6_000);
  });

  it('pasado el enfriamiento deja pasar UNA sola prueba; si sale bien se cierra', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.onFailure();
    advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(false); // la segunda concurrente no pasa
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('si la prueba falla vuelve a abrirse con un enfriamiento nuevo (un solo fallo alcanza)', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.onFailure();
    advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.retryAfterMs()).toBe(10_000);
    expect(breaker.tryAcquire()).toBe(false);
  });
});
