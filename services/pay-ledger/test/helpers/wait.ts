/** Espera por condición (nunca por tiempo fijo): reintenta `condition` hasta que devuelva algo verdadero o venza `timeoutMs`. */
export async function waitFor<T>(condition: () => Promise<T | false | undefined>, timeoutMs = 10_000, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`La condición no se cumplió en ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
