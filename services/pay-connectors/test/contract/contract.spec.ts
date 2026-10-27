import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HttpMockBankClient } from '../../src/connectors/mock/mockbank-http.client';
import { MockConnector } from '../../src/connectors/mock/mock.connector';
import { SimulatedBank } from '../../src/connectors/mock/simulated-bank';
import { BankTransferConnector, type TransferReferenceStore } from '../../src/connectors/bank-transfer/bank-transfer.connector';
import { EnvSecretProvider } from '../../src/domain/secrets';
import { Launcher, type Bank } from '../support/mockbank';
import { buildService, freePort } from '../support/process';
import { defineConnectorContract, uniqueQr, type Harness, type Spec } from './connector-contract';

// P4.H4.M1 — Suite de contrato PARAMETRIZADA POR CONECTOR. `CONNECTOR=mock|bank_transfer|mercantil_qr|mercantil_card yarn test:contract`
// (sin variable: todos). La MISMA suite (`connector-contract.ts`) corre contra el banco en proceso y contra el pay-mockbank real por HTTP.
// Los adaptadores reales del Mercantil están BLOQUEADOS: ver el último bloque.
const KNOWN = ['mock', 'bank_transfer', 'mercantil_qr', 'mercantil_card'] as const;
type Code = (typeof KNOWN)[number];
const selected = process.env.CONNECTOR;
if (selected !== undefined && selected !== '' && !(KNOWN as readonly string[]).includes(selected)) {
  throw new Error(`CONNECTOR inválido: ${selected} (válidos: ${KNOWN.join(', ')})`);
}
const wants = (code: Code): boolean => !selected || selected === code;

const asAdmin = { 'content-type': 'application/json', 'x-service-id': 'pay-mockbank' };
const launcher = new Launcher();
let bankPromise: Promise<Bank> | undefined;
/** Un solo pay-mockbank real para todos los bindings HTTP de esta corrida (se levanta la primera vez que alguien lo pide). */
const sharedBank = (): Promise<Bank> => {
  bankPromise ??= (async () => {
    buildService('pay-mockbank');
    return launcher.startBank(await freePort(), { deliveryMs: 0, hangMs: 1500, delayMs: 400 }); // sin receptor de callbacks: aquí solo se ejercita el contrato del conector
  })();
  return bankPromise;
};
afterAll(async () => launcher.cleanup());

/** [DOBLE] Almacén de referencias de transferencia en memoria (la implementación real es una tabla; esta suite no necesita base). */
class MemoryReferences implements TransferReferenceStore {
  private readonly rows = new Map<string, { reference: string; expiresAt: Date }>();
  private n = 0;
  async getOrCreate(chargeId: string, expiresAt: Date): Promise<{ reference: string; expiresAt: Date }> {
    const found = this.rows.get(chargeId);
    if (found) return found;
    const row = { reference: `TR${String((this.n += 1)).padStart(10, '0')}`, expiresAt };
    this.rows.set(chargeId, row);
    return row;
  }
  async find(chargeId: string): Promise<{ reference: string; expiresAt: Date } | null> {
    return this.rows.get(chargeId) ?? null;
  }
}

const MOCK_AMOUNTS = { paid: 10000n, neverPaid: 10008n, ambiguous: 10007n, declined: 10001n } as const;
const MOCK_CAPABILITIES = { chargeNeedsBank: true, canBeDown: true, refunds: true, callbacks: true, transfers: true, statementShowsCharges: true, statementShowsDeposits: false } as const;

function mockHarness(connector: MockConnector, extras: Pick<Harness, 'setDown' | 'close'>): Harness {
  return {
    connector,
    now: () => new Date(),
    ...extras,
    signCallback: (input) =>
      connector.signCallback({ dueAt: new Date(), eventId: input.id, reference: input.reference, status: input.status, occurredAt: new Date(), amountMinor: input.amountMinor }, new Date()),
  };
}

if (wants('mock')) {
  const inProcess: Spec = { methods: ['qr', 'card', 'bank_transfer'], amounts: MOCK_AMOUNTS, capabilities: { ...MOCK_CAPABILITIES, timeTravel: true } };
  defineConnectorContract('mock — banco en proceso (SimulatedBank)', inProcess, async () => {
    const bank = new SimulatedBank({ seed: 7 });
    const connector = new MockConnector({ bank, secrets: new EnvSecretProvider(), qr: uniqueQr() });
    return mockHarness(connector, { setDown: async (down) => bank.setDown(down), close: async () => undefined });
  });

  // El mismo conector `mock`, con el banco DETRÁS en otro proceso: pay-mockbank por HTTP.
  const overHttp: Spec = { methods: ['qr', 'card', 'bank_transfer'], amounts: MOCK_AMOUNTS, capabilities: { ...MOCK_CAPABILITIES, timeTravel: false } };
  defineConnectorContract('mock — pay-mockbank por HTTP (proceso real)', overHttp, async () => {
    const bank = await sharedBank();
    const client = new HttpMockBankClient({ baseUrl: bank.base, account: 'collections', timeoutMs: 400 });
    const connector = new MockConnector({ bank: client, secrets: new EnvSecretProvider(), qr: uniqueQr() });
    return mockHarness(connector, {
      setDown: async (down) => {
        await fetch(`${bank.base}/sandbox/admin/down`, { method: 'PUT', headers: asAdmin, body: JSON.stringify({ down }) });
      },
      close: async () => undefined,
    });
  });
}

if (wants('bank_transfer')) {
  const transferSpec: Spec = {
    methods: ['bank_transfer'],
    amounts: { paid: 20000n },
    capabilities: { timeTravel: true, canBeDown: true, chargeNeedsBank: false, refunds: false, callbacks: false, transfers: false, statementShowsCharges: false, statementShowsDeposits: true },
  };
  defineConnectorContract('bank_transfer — extracto en proceso (SimulatedBank)', transferSpec, async () => {
    const bank = new SimulatedBank({ seed: 9 });
    const connector = new BankTransferConnector('sandbox', new MemoryReferences(), { fetch: async (range) => bank.statement(range), probe: async () => bank.probe() });
    return {
      connector,
      now: () => new Date(),
      setDown: async (down) => bank.setDown(down),
      deposit: async (reference, amountMinor) =>
        bank.injectStatementLine({ providerReference: `DEP-${reference}`, ourReference: reference, direction: 'credit', amountMinor, currency: 'BOB', valueDate: new Date().toISOString().slice(0, 10), bookedAt: new Date(), description: null }),
      close: async () => undefined,
    };
  });

  defineConnectorContract('bank_transfer — cuenta `transfers` de pay-mockbank (proceso real)', transferSpec, async () => {
    const bank = await sharedBank();
    const source = new HttpMockBankClient({ baseUrl: bank.base, account: 'transfers', timeoutMs: 400 });
    const connector = new BankTransferConnector('sandbox', new MemoryReferences(), { fetch: async (range) => source.statement(range), probe: async () => source.probe() });
    return {
      connector,
      now: () => new Date(),
      setDown: async (down) => {
        await fetch(`${bank.base}/sandbox/admin/down`, { method: 'PUT', headers: asAdmin, body: JSON.stringify({ down }) });
      },
      deposit: async (reference, amountMinor) => {
        const response = await fetch(`${bank.base}/sandbox/payer/transfer-in`, { method: 'POST', headers: asAdmin, body: JSON.stringify({ reference, amount_minor: Number(amountMinor) }) });
        if (response.status !== 201) throw new Error(`el depósito falló: ${response.status}`);
      },
      close: async () => undefined,
    };
  });
}

// ───────────────────────── Los conectores REALES del Banco Mercantil: BLOQUEADOS ─────────────────────────
// No existen adaptadores (`mercantil_qr`, `mercantil_card`): el banco no publica su documentación ni su ambiente de pruebas
// (docs/spikes/banco-mercantil.md; los campos, rutas y mensajes de esos adaptadores NO deben escribirse antes de tener el documento).
// Cuando exista el adaptador se agrega su `Spec` + `Harness` ARRIBA y corre esta misma suite; entonces la primera prueba de abajo FALLA a propósito
// para que nadie deje la suite sin habilitar.
const BLOCKED_REASON = 'BLOQUEADA — el Banco Mercantil Santa Cruz no entregó documentación de API ni ambiente de pruebas (docs/spikes/banco-mercantil.md, Q-01, Q-11)';
for (const code of ['mercantil_qr', 'mercantil_card'] as const) {
  if (!wants(code)) continue;
  describe(`${code} — ${BLOCKED_REASON}`, () => {
    it('hoy NO existe el adaptador real: cuando exista, esta prueba falla y obliga a correr la suite de contrato completa contra él', () => {
      const dir = join(process.cwd(), 'src/connectors');
      expect(existsSync(join(dir, code.replace('_', '-')))).toBe(false);
      expect(existsSync(join(dir, `${code.replace('_', '-')}.connector.ts`))).toBe(false);
    });
    it.todo(`la suite completa de contrato corre contra ${code} — ${BLOCKED_REASON}; destraba: documentación y credenciales de sandbox del banco`);
  });
}

