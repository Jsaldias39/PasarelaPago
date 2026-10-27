import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadEventContract, type EventContract } from './events';

const FILE = join(__dirname, '../../../asyncapi/payments.yaml');
let contract: EventContract;
beforeAll(async () => {
  contract = await loadEventContract(FILE);
});

interface Doc {
  components: { messages: Record<string, { name: string; examples?: { payload: Record<string, unknown> }[] }> };
}
const examples = Object.values((parse(readFileSync(FILE, 'utf8')) as Doc).components.messages)
  .filter((m) => m.examples?.[0])
  .map((m) => ({ type: m.name, event: m.examples![0].payload }));

describe('loadEventContract', () => {
  it('CORRECTO: expone los temas y valida cada ejemplo del contrato en su canal', () => {
    expect(contract.subjects().length).toBeGreaterThanOrEqual(13);
    expect(examples.length).toBeGreaterThanOrEqual(13);
    for (const { type, event } of examples) expect(contract.validate(`pay-payments.${type}`, event)).toEqual([]);
  });

  it('INVÁLIDO: un evento al que le falta un campo requerido o trae uno de más no cumple', () => {
    const { event } = examples.find((e) => e.type === 'payment_intent.succeeded')!;
    const data = event.data as Record<string, unknown>;
    const withoutCurrency: Record<string, unknown> = { ...data };
    delete withoutCurrency.currency;
    expect(contract.validate('pay-payments.payment_intent.succeeded', { ...event, data: withoutCurrency })).not.toEqual([]);
    expect(contract.validate('pay-payments.payment_intent.succeeded', { ...event, specversion: '0.3' })).not.toEqual([]);
    expect(contract.validate('pay-payments.payment_intent.succeeded', { ...event, data: { ...data, amount_minor: -1 } })).not.toEqual([]);
  });

  it('LÍMITE: un evento válido en el canal EQUIVOCADO no cumple, y un canal que no existe se informa', () => {
    const { event } = examples.find((e) => e.type === 'payment_intent.succeeded')!;
    expect(contract.validate('pay-payments.refund.created', event)).not.toEqual([]);
    expect(contract.validate('pay-payments.no.existe', event)).toEqual(['El contrato no define el canal pay-payments.no.existe']);
  });
});
