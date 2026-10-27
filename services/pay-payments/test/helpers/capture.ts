/** Todo lo que el proceso escribe a stdout/stderr mientras dura `work`: sirve para comprobar que ningún log trae datos de tarjeta. */
export async function captureOutput<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const spy = (original: typeof out) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof out;
  process.stdout.write = spy(out);
  process.stderr.write = spy(err);
  let result: T;
  try {
    result = await work();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { result, output: chunks.join('') };
}
