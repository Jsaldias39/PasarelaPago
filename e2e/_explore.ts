import { readFileSync } from 'node:fs';
import { seedMerchant, waitForEdgeToKnow } from './lib/seed.ts';
import { publicApi } from './lib/flow.ts';
import { ALL_SERVICES } from './lib/services.ts';
import { startStack, stopStack } from './stack.ts';

const otel = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:54318', OTEL_BSP_SCHEDULE_DELAY: '300' };
const envOverrides = Object.fromEntries(ALL_SERVICES.map((n) => [n, otel]));
const stack = await startStack({ tolerateFailures: false, envOverrides });
try {
  const m = await seedMerchant(stack, { label: 'EXPLORE' });
  await waitForEdgeToKnow(stack, m);
  const tid = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const res = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { authorization: `Bearer ${m.token}`, 'idempotency-key': 'explore-0001-key', traceparent: `00-${tid}-00f067aa0ba902b7-01`, 'x-request-id': 'explore-req-0001', 'user-agent': 'e2e-explore' }, json: { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } } });
  console.log('status', res.status, res.text.slice(0, 200));
  const api = publicApi(stack, m);
  await api.settle((res.json as { id: string }).id);
  await new Promise((r) => setTimeout(r, 3000));
  const j = await (await fetch(`http://127.0.0.1:54686/api/traces/${tid}`)).json() as any;
  const trace = j.data?.[0];
  const procs = trace.processes;
  for (const s of trace.spans.sort((a: any, b: any) => a.startTime - b.startTime)) {
    const ref = s.references.map((r: any) => r.refType + ':' + r.spanID).join(',');
    console.log(procs[s.processID].serviceName, s.spanID, 'parent=' + ref, s.operationName, s.tags.filter((t: any) => /http\.(method|route|status|target|user)|user_agent/.test(t.key)).map((t: any) => t.key + '=' + t.value).join(' '));
  }
  for (const n of ALL_SERVICES) {
    try { const l = readFileSync(stack.services[n].logFile, 'utf8').split('\n').filter((x) => x.includes('explore-req-0001')); console.log(n, 'log lines with req id:', l.length); } catch {}
  }
} finally {
  await stopStack(stack, { keepLogs: true });
}
