/**
 * CLI del pagador simulado: `mockbank pay <qr>` y `mockbank transfer <referencia> <centavos>`. Hablan con los endpoints del pagador de `pay-mockbank` (MOCKBANK_URL).
 * Separado de `cli.ts` para poder probarlo sin lanzar un proceso.
 */
export interface CliIo {
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl: typeof fetch;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const USAGE = 'uso: mockbank pay <payload-del-QR> | mockbank transfer <referencia> <importe-en-centavos>   (MOCKBANK_URL, por defecto http://127.0.0.1:3112)';

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, first, second, ...rest] = argv;
  let path: string;
  let body: Record<string, unknown>;
  if (command === 'pay' && first && second === undefined) {
    path = '/sandbox/payer/pay';
    body = { qr_payload: first };
  } else if (command === 'transfer' && first && second && rest.length === 0 && /^[1-9][0-9]{0,11}$/.test(second)) {
    path = '/sandbox/payer/transfer-in';
    body = { reference: first, amount_minor: Number(second) };
  } else {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const base = (io.env.MOCKBANK_URL ?? 'http://127.0.0.1:3112').replace(/\/$/, '');
  let response: Response;
  try {
    response = await io.fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-id': 'pay-mockbank' },
      body: JSON.stringify(body),
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
    io.err(`mockbank: la operación falló: HTTP ${response.status} ${code}\n`);
    return 1;
  }
  io.out(`${text}\n`);
  return 0;
}
