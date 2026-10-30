/** Espera por CONDICIÓN (nunca por tiempo fijo): repite `probe` hasta que `accept` lo acepte o venza el tope, y devuelve el último valor. */
export async function until<T>(description: string, probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 30_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (accept(last)) return last;
    if (Date.now() > deadline) throw new Error(`No se cumplió «${description}» en ${timeoutMs} ms; último valor: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
