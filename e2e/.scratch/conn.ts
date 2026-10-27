import { connect } from 'nats';
import { startStack, stopStack } from '../stack.ts';
const s = await startStack({ only: ['pay-qr', 'pay-connectors'] as never });
const nc = await connect({ servers: s.infra.natsUrl });
try {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const cents of ['00', '03', '04', '05']) {
    const pi = `pi_e2e${cents}${Math.random().toString(36).slice(2, 10)}`;
    const create = await s.callAs('pay-payments', 'pay-connectors', 'POST', '/charges', { headers: { 'idempotency-key': `idem-${pi}-0001` }, json: { payment_intent_id: pi, merchant_id: 'mc_abcdefghij12', amount_minor: 10000 + Number(cents), currency: 'BOB', method: 'qr', expires_at: new Date(Date.now() + 600000).toISOString() }, merchantId: 'mc_abcdefghij12' });
    console.log(cents, 'create', create.status, JSON.stringify(create.json).slice(0, 300));
    const id = (create.json as { id: string }).id;
    await sleep(4000);
    const got = await s.callAs('pay-payments', 'pay-connectors', 'GET', `/charges/${id}`, {});
    console.log(cents, 'get', got.status, (got.json as { status: string }).status);
    const st = await s.callAs('pay-payments', 'pay-connectors', 'GET', `/charges/${id}/status`, {});
    console.log(cents, 'status', st.status, JSON.stringify(st.json).slice(0, 300));
  }
  const jsm = await nc.jetstreamManager();
  const c = await nc.jetstream().consumers.get('PAY_CONNECTORS', await (async () => { const i = await jsm.consumers.add('PAY_CONNECTORS', { ack_policy: 'none' as never, deliver_policy: 'all' as never, filter_subject: 'pay-connectors.connector.transaction.status_changed' }); return i.name; })());
  const msgs = await c.fetch({ max_messages: 50, expires: 1500 });
  for await (const m of msgs) { const e = JSON.parse(m.string()); console.log('EVT', e.id.slice(0, 8), JSON.stringify(e.data).slice(0, 330)); }
} finally { await nc.close(); await stopStack(s); }
