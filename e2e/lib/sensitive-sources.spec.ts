import { scanSources, scanText, SYNTHETIC_PANS } from './pan-scan.ts';
import { historyText } from './sensitive-sources.ts';

/**
 * `historyText` arma el texto que E7 escanea de cada historial de Temporal. Excluye SOLO la identidad del worker (hash del bundle); un PAN en un payload tiene que seguir apareciendo.
 * Correcto: el PAN sintético dentro de un payload se encuentra. Límite: una tira de dígitos con forma de tarjeta dentro de `buildId` NO se reporta (caso real: 15 dígitos «3529…»,
 * Luhn válido, dentro de un hash hexadecimal de 64 caracteres). Inválido: el mismo número fuera de la identidad del worker SÍ se reporta.
 */
describe('historyText', () => {
  // Hash hexadecimal de 64 caracteres con una tira de 15 dígitos válida por Luhn y con prefijo 3529 (JCB), armado a mano: no es de ninguna tarjeta.
  const CARD_SHAPED_DIGITS = '352900000000005';
  const BUILD_ID = `@temporalio/worker@1.24.0+dd0e997fea3f4ee90d3cbff7871845e95e${CARD_SHAPED_DIGITS}df7c53be6ac04`;

  it('CORRECTO: el PAN sintético dentro de un payload sigue encontrándose', () => {
    const history = { events: [{ activityTaskScheduledEventAttributes: { input: { payloads: [{ data: new Uint8Array(Buffer.from(`{"card":"${SYNTHETIC_PANS.visa}"}`)) }] } } }] };
    const text = historyText(history);
    expect(scanSources([{ source: 'temporal:wf', text }]).hits.map((h) => h.kind)).toContain('known_pan');
  });

  it('LÍMITE: una tira con forma de tarjeta dentro de buildId / binaryChecksum no se reporta', () => {
    expect(scanText('t', JSON.stringify({ workerVersion: { buildId: BUILD_ID } })).length).toBeGreaterThan(0); // sin el filtro, el detector SÍ la marcaba
    const history = { events: [{ workerVersion: { buildId: BUILD_ID }, binaryChecksum: BUILD_ID }] };
    expect(scanSources([{ source: 'temporal:wf', text: historyText(history) }]).hits).toEqual([]);
  });

  it('INVÁLIDO: el mismo número en cualquier otro campo (memo, cabecera, fallo) SÍ se reporta', () => {
    const history = { events: [{ memo: { fields: { nota: `pago con ${CARD_SHAPED_DIGITS}` } }, buildId: BUILD_ID }] };
    const hits = scanSources([{ source: 'temporal:wf', text: historyText(history) }]).hits;
    expect(hits.map((h) => h.kind)).toEqual(['card_like_number']);
  });
});
