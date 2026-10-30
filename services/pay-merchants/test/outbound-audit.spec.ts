import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Auditoría de llamadas SALIENTES de pay-merchants (D-28, ola 2b): qué archivos de `src/` abren conexiones de red hacia otro servicio.
 * Si aparece uno nuevo, esta prueba falla y obliga a decidir cómo propaga `X-Service-Id` y `X-Pay-Mode` (y a escribir su prueba contra el contrato).
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const OUTBOUND = /\b(fetch\(|axios|https?\.request|https?\.get\(|undici|got\(|XMLHttpRequest|node-fetch|\.request\()/;

describe('llamadas salientes de pay-merchants (ninguna: solo publica eventos por outbox y no llama a otros servicios; no hay X-Pay-Mode que propagar)', () => {
  it('merchants: lista exacta de archivos con llamadas HTTP salientes', () => {
    const files = sources(join(process.cwd(), 'src')).filter((f) => OUTBOUND.test(readFileSync(f, 'utf8'))).map((f) => f.slice(process.cwd().length + 1)).sort();
    expect(files).toEqual([]);
  });
});
