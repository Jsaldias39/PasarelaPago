import request from 'supertest';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import { REGISTRY } from '../src/core/tokens';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { asPayments, chargeBody, createTestApp, post, uniqueKey } from './support/app';
import { verify } from '@pay/webhook-signature';

it('debug', async () => {
  const t = await createTestApp();
  const bank = t.app.get(SIMULATED_BANK);
  const mock = t.app.get(REGISTRY).get('mock') as MockConnector;
  const c = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
  const due = bank.dueCallbacks(t.clock.now());
  const signed = await mock.signCallback(due[0]!, t.clock.now());
  console.log(JSON.stringify(signed.headers), signed.rawBody.toString());
  const secret = process.env.PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET!;
  try { verify({ headers: signed.headers, payload: signed.rawBody, secrets: [secret], now: Math.floor(t.clock.now().getTime() / 1000) }); console.log('verify ok'); } catch (e) { console.log('verify fail', (e as Error).message); }
  const r = await request(t.app.getHttpServer()).post('/callbacks/mock').set(signed.headers).set('content-type', 'application/json').send(signed.rawBody);
  console.log(r.status, JSON.stringify(r.body), c.status);
  await t.close();
});
