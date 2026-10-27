/**
 * CLI del pagador simulado: `mockbank pay <qr>`. Habla con el endpoint `POST /sandbox/payer/pay` de `pay-mockbank` (MOCKBANK_URL).
 * Separado de `cli.ts` para poder probarlo sin lanzar un proceso.
 */
export interface CliIo {
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl: typeof fetch;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const USAGE = 'uso: mockbank pay <payload-del-QR>   (MOCKBANK_URL, por defecto http://127.0.0.1:3112)';

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, qr, ...rest] = argv;
  if (command !== 'pay' || !qr || rest.length > 0) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const base = (io.env.MOCKBANK_URL ?? 'http://127.0.0.1:3112').replace(/\/$/, '');
  let response: Response;
  try {
    response = await io.fetchImpl(`${base}/sandbox/payer/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-id': 'pay-mockbank' },
      body: JSON.stringify({ qr_payload: qr }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    io.err('mockbank: no se pudo conectar con pay-mockbank\n');
    return 1;
  }
  const text = await response.text();
  if (!response.ok) {
    // Se muestra solo el `code` y el estado del problema: el cuerpo crudo del servidor no se repite.
    let code = 'error';
    try {
      const parsed = JSON.parse(text) as { code?: unknown; errors?: Array<{ code?: unknown }> };
      code = typeof parsed.code === 'string' ? `${parsed.code}${parsed.errors?.[0]?.code ? ` (${String(parsed.errors[0].code)})` : ''}` : code;
    } catch {
      /* cuerpo no JSON */
    }
    io.err(`mockbank: el pago falló: HTTP ${response.status} ${code}\n`);
    return 1;
  }
  io.out(`${text}\n`);
  return 0;
}
