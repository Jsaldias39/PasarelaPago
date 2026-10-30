import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { newCloudEvent } from './cloudevent';

const schema = JSON.parse(readFileSync(join(__dirname, '../../../schemas/cloudevent.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('CloudEvent', () => {
  const base = { source: '/pay-payments', type: 'payment_intent.succeeded', data: { id: 'pi_1', amount_minor: 10000 } };

  it('un evento construido cumple el esquema', () => {
    expect(validate(newCloudEvent(base))).toBe(true);
    expect(validate(newCloudEvent({ ...base, subject: 'pi_1', merchantId: 'm_1', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }))).toBe(true);
  });

  it('cada evento nuevo tiene un id distinto y la versión 1.0', () => {
    const a = newCloudEvent(base);
    const b = newCloudEvent(base);
    expect(a.id).not.toBe(b.id);
    expect(a.specversion).toBe('1.0');
  });

  it.each([
    ['sin data', { ...newCloudEvent(base), data: undefined }],
    ['id que no es UUID', { ...newCloudEvent(base), id: 'abc' }],
    ['tipo sin punto', { ...newCloudEvent(base), type: 'succeeded' }],
    ['tipo en mayúsculas', { ...newCloudEvent(base), type: 'Payment.Succeeded' }],
    ['origen que no es de un servicio pay-*', { ...newCloudEvent(base), source: '/otro' }],
    ['traceparent mal formado', { ...newCloudEvent(base), traceparent: 'x' }],
    ['campo extra', { ...newCloudEvent(base), extra: 1 }],
  ])('el esquema rechaza %s', (_name, event) => {
    expect(validate(event)).toBe(false);
  });
});
