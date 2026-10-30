import { appendFileSync } from 'node:fs'; const out = (...a: unknown[]) => appendFileSync('<carpeta-de-la-evidencia>/results.txt', a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
import { createRequire } from 'node:module';
import { createHmac, randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { verifyStandardWebhook } from '/home/user/mantra-core-health-api/src/modules/payments/gateway/standard-webhook-signature';
const require = createRequire(import.meta.url);
const ref = require('/home/user/pasarelapago/contracts/packages/webhook-signature/dist/index.js');

const NOW = 1_800_000_000;
function outcome(fn: () => void): string {
  try { fn(); return 'ok'; } catch (e: any) { return e?.reason ?? `THROW:${e?.constructor?.name}`; }
}
describe('paridad adversarial API vs @pay/webhook-signature (dist)', () => {
  const secret = ref.generateSecret(32);
  const secret2 = ref.generateSecret(24);
  const kp = ref.generateKeyPair();
  const id = 'msg_abc';
  const payloads: (string | Buffer)[] = ['{"a":1}', '', Buffer.from([0xff, 0xfe, 0x00]), 'señal ñandú', ' '.repeat(10)];
  const mutations: ((h: Record<string, any>) => Record<string, any>)[] = [
    (h) => h,
    (h) => ({ ...h, 'webhook-signature': h['webhook-signature'] + ' ' + h['webhook-signature'] }),
    (h) => ({ ...h, 'webhook-signature': '  ' + h['webhook-signature'] }),
    (h) => ({ ...h, 'webhook-signature': h['webhook-signature'] + '\t' }),
    (h) => ({ ...h, 'webhook-signature': h['webhook-signature'].replace(',', ',,') }),
    (h) => ({ ...h, 'webhook-signature': h['webhook-signature'].replace(/=+$/, '') }),
    (h) => ({ ...h, 'webhook-signature': h['webhook-signature'].replace(/\+/g, '-').replace(/\//g, '_') }),
    (h) => ({ ...h, 'webhook-signature': h['webhook-signature'] + 'AAAA' }),
    (h) => ({ ...h, 'webhook-signature': 'V1,' + h['webhook-signature'].slice(3) }),
    (h) => ({ ...h, 'webhook-signature': [h['webhook-signature'], 'v1,zzzz'] }),
    (h) => ({ ...h, 'webhook-id': [h['webhook-id'], 'otro'] }),
    (h) => ({ ...h, 'webhook-timestamp': '0' + h['webhook-timestamp'] }),
    (h) => ({ ...h, 'webhook-timestamp': h['webhook-timestamp'] + ' ' }),
    (h) => ({ ...h, 'webhook-timestamp': '+' + h['webhook-timestamp'] }),
    (h) => ({ ...h, 'webhook-timestamp': '١٨٠٠٠٠٠٠٠٠' }),
    (h) => ({ ...h, 'webhook-timestamp': String(NOW + 301) }),
    (h) => ({ ...h, 'webhook-timestamp': '9'.repeat(13) }),
    (h) => ({ 'WEBHOOK-ID': h['webhook-id'], 'Webhook-Timestamp': h['webhook-timestamp'], 'webhook-SIGNATURE': h['webhook-signature'] }),
    (h) => ({ ...h, 'webhook-id': '' }),
    (h) => ({ ...h, 'webhook-signature': 'v1a,' + h['webhook-signature'].slice(3) }),
  ];
  it('mismo veredicto en cientos de casos', () => {
    const diffs: string[] = [];
    let n = 0;
    for (const payload of payloads) {
      for (const tol of [undefined, 30, 0]) {
        const hdrs = ref.signedHeaders({ id, timestamp: NOW, payload, secrets: [secret, secret2], secretKeys: [kp.secretKey] });
        const hv1 = { ...hdrs, 'webhook-signature': hdrs['webhook-signature'].split(' ').filter((s: string) => s.startsWith('v1,')).join(' ') };
        for (const base of [hdrs, hv1]) {
          mutations.forEach((m, mi) => {
            for (const trust of [{ secrets: [secret] }, { secrets: [secret2] }, { publicKeys: [kp.publicKey] }, { secrets: [secret], publicKeys: [kp.publicKey] }, {}]) {
              for (const nowOff of [0, 299, 300, 301, -301]) {
                const input: any = { headers: m({ ...base }), payload, toleranceSeconds: tol, now: NOW + nowOff, ...trust };
                const a = outcome(() => verifyStandardWebhook(input));
                const b = outcome(() => ref.verify(input));
                n++;
                if (a !== b) diffs.push(`mut=${mi} tol=${tol} nowOff=${nowOff} trust=${Object.keys(trust)} api=${a} ref=${b}`);
              }
            }
          });
        }
      }
    }
    out(`casos=${n} divergencias=${diffs.length}`, diffs.slice(0, 10));
    expect(diffs).toEqual([]);
  });
  it('hallazgos de comportamiento compartido (no divergencia)', () => {
    const h = ref.signedHeaders({ id, timestamp: NOW, payload: 'x', secrets: [secret] });
    const lenient = { ...h, 'webhook-signature': h['webhook-signature'] + ' v1,' + 'A'.repeat(10) };
    out('firma + basura en 2do candidato =>', outcome(() => verifyStandardWebhook({ headers: lenient, payload: 'x', secrets: [secret], now: NOW })));
    const noPad = { ...h, 'webhook-signature': h['webhook-signature'].replace(/=+$/, '') };
    out('firma sin padding base64 =>', outcome(() => verifyStandardWebhook({ headers: noPad, payload: 'x', secrets: [secret], now: NOW })));
    const url = { ...h, 'webhook-signature': h['webhook-signature'] + 'AAAA' };
    out('firma con 3 bytes de cola =>', outcome(() => verifyStandardWebhook({ headers: url, payload: 'x', secrets: [secret], now: NOW })));
    const trailingComma = { ...h, 'webhook-signature': h['webhook-signature'] + ',garbage' };
    out('firma + ",garbage" =>', outcome(() => verifyStandardWebhook({ headers: trailingComma, payload: 'x', secrets: [secret], now: NOW })));
  });
});
