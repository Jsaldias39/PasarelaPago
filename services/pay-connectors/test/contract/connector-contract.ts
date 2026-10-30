import { randomBytes } from 'node:crypto';
import {
  ConnectorRejectedError,
  ConnectorTimeoutError,
  ConnectorUnavailableError,
  type Connector,
  type Method,
  type NextAction,
  type ProviderStatus,
  type StatementLine,
} from '../../src/domain/connector';
import { crc16 } from '../support/app';

/**
 * SUITE DE CONTRATO del `Connector` (P4.H4.M1). Es UNA sola suite: se corre idéntica contra cada conector y cada «banco» que haya detrás.
 * Lo que un conector no puede (por ejemplo, la transferencia bancaria no reembolsa) se declara en `Spec.capabilities` y aparece como
 * `todo` con su motivo: nunca se omite en silencio. Cuando exista el adaptador real (mercantil_qr, mercantil_card) se agrega un `Spec` y corre ESTA suite.
 */
export interface Spec {
  /** Medios que el conector declara. */
  readonly methods: readonly Method[];
  /** Importes que disparan cada escenario en el banco que hay detrás (tabla de ESCENARIOS.md). `undefined` = ese banco no tiene el escenario. */
  readonly amounts: { readonly paid: bigint; readonly neverPaid?: bigint; readonly ambiguous?: bigint; readonly declined?: bigint };
  readonly capabilities: {
    /** El conector recibe `now` de quien llama (banco en proceso); un banco remoto usa su propia hora y no se le puede adelantar el reloj. */
    readonly timeTravel: boolean;
    /** Se puede apagar el banco (`Harness.setDown`): la sonda y el extracto lo notan. */
    readonly canBeDown: boolean;
    /** Crear un cobro necesita hablar con el banco (la transferencia bancaria solo reserva una referencia propia). */
    readonly chargeNeedsBank: boolean;
    /** Reembolsa un cobro cobrado. */
    readonly refunds: boolean;
    /** Recibe callbacks firmados del banco (`Harness.signCallback`). */
    readonly callbacks: boolean;
    /** Orden de transferencia SALIENTE (`createTransfer`/`getTransfer`). */
    readonly transfers: boolean;
    /** El extracto del conector muestra los cobros que cobró. */
    readonly statementShowsCharges: boolean;
    /** El conector se confirma por depósitos en el extracto (transferencia bancaria; `Harness.deposit`). */
    readonly statementShowsDeposits: boolean;
  };
}

export interface Harness {
  readonly connector: Connector;
  /** Instante actual de referencia para las llamadas al conector. */
  now(): Date;
  setDown?(down: boolean): Promise<void>;
  signCallback?(input: { id: string; reference: string; status: ProviderStatus; amountMinor: bigint }): Promise<{ headers: Record<string, string>; rawBody: Buffer }>;
  deposit?(reference: string, amountMinor: bigint): Promise<void>;
  close(): Promise<void>;
}

export const EMV = /^000201.*6304[0-9A-F]{4}$/;
const STATUSES = new Set<string>(['pending', 'authorized', 'captured', 'failed', 'canceled', 'expired']);
const newCharge = (): string => `ch_${randomBytes(8).toString('hex')}`;
const newRefund = (): string => `cr_${randomBytes(8).toString('hex')}`;
const newTransfer = (): string => `po_${randomBytes(6).toString('hex')}:payout:1`;

/** [DOBLE] pay-qr: un payload con forma de EMVCo MPM y CRC válido, DISTINTO por cobro (un banco con pagador rechaza dos cobros con el mismo QR). */
export function uniqueQr(): { issue(input: { chargeId: string; amountMinor: bigint; expiresAt: Date }): Promise<{ payload: string; expiresAt: Date }> } {
  return {
    async issue(input) {
      const suffix = input.chargeId.slice(-12);
      const amount = String(input.amountMinor);
      const body = `00020101021254${String(amount.length).padStart(2, '0')}${amount}5802BO62${String(suffix.length + 4).padStart(2, '0')}05${String(suffix.length).padStart(2, '0')}${suffix}6304`;
      return { payload: `${body}${crc16(body)}`, expiresAt: input.expiresAt };
    },
  };
}

export function defineConnectorContract(title: string, spec: Spec, build: () => Promise<Harness>): void {
  const { capabilities: cap, amounts } = spec;
  const firstMethod = spec.methods[0] as Method;
  const deposits = cap.statementShowsDeposits;
  /** Un caso que no aplica a este conector queda como `todo` con su motivo (visible en la salida), no como una prueba vacía que pasa. */
  const only = (applies: boolean, reason: string, name: string, fn: () => Promise<void>): void => {
    if (applies) it(name, fn);
    else it.todo(`${name} — NO APLICA: ${reason}`);
  };

  describe(title, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await build();
    }, 180_000);
    afterAll(async () => h.close());
    afterEach(async () => h.setDown?.(false));

    const request = (method: Method, amountMinor: bigint, reference = newCharge()) => ({
      reference,
      paymentIntentId: `pi_${randomBytes(6).toString('hex')}`,
      merchantId: 'mc_clinicasantacruz1',
      payMode: 'test' as const,
      amountMinor,
      currency: 'BOB' as const,
      method,
      expiresAt: new Date(h.now().getTime() + 3_600_000),
    });
    const expectAction = (method: Method, action: NextAction | undefined): void => {
      expect(action).toBeDefined();
      if (method === 'qr') {
        expect(action).toMatchObject({ type: 'display_qr' });
        expect((action as { payload: string }).payload).toMatch(EMV);
      } else if (method === 'card') {
        expect(action).toMatchObject({ type: 'redirect_to_card_form' });
        expect((action as { url: string }).url).toMatch(/^https:\/\//);
      } else {
        expect(action).toMatchObject({ type: 'bank_transfer_instructions' });
        expect((action as { reference: string }).reference.length).toBeGreaterThan(0);
      }
    };

    describe('declaración', () => {
      it('código, modo sandbox y medios soportados coinciden con lo declarado', () => {
        expect(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']).toContain(h.connector.code);
        expect(h.connector.mode).toBe('sandbox');
        expect([...h.connector.methods].sort()).toEqual([...spec.methods].sort());
      });
    });

    describe('createCharge / getStatus / cancel', () => {
      it('correcto: por cada medio declarado crea el cobro con la acción siguiente de su tipo, y repetir la referencia devuelve el MISMO cobro', async () => {
        for (const method of spec.methods) {
          const req = request(method, amounts.paid);
          const first = await h.connector.createCharge(req, h.now());
          expect(first.providerReference.length).toBeGreaterThan(0);
          expect(STATUSES.has(first.status)).toBe(true);
          expectAction(method, first.nextAction);
          const again = await h.connector.createCharge(req, h.now());
          expect(again.providerReference).toBe(first.providerReference);
        }
      });

      it('correcto: getStatus devuelve un estado válido con su instante; un cobro aprobado termina `captured` (o sigue `pending` si el medio se confirma por extracto)', async () => {
        const req = request(firstMethod, amounts.paid);
        await h.connector.createCharge(req, h.now());
        const status = await h.connector.getStatus(req.reference, h.now());
        expect(STATUSES.has(status.status)).toBe(true);
        expect(status.occurredAt).toBeInstanceOf(Date);
        expect(status.status).toBe(deposits ? 'pending' : 'captured');
      });

      only(
        cap.timeTravel && (amounts.neverPaid !== undefined || deposits),
        'un banco remoto usa su propia hora, o cobra al instante (no hay cobro que venza); el vencimiento se prueba en test/mockbank.spec.ts (caso 08)',
        'límite: un cobro que nadie paga sigue `pending` hasta su vencimiento y recién entonces se informa `expired`',
        async () => {
          const req = { ...request(firstMethod, amounts.neverPaid ?? amounts.paid), expiresAt: new Date(h.now().getTime() + 600_000) };
          await h.connector.createCharge(req, h.now());
          expect((await h.connector.getStatus(req.reference, new Date(req.expiresAt.getTime() - 1))).status).toBe('pending');
          expect((await h.connector.getStatus(req.reference, req.expiresAt)).status).toBe('expired');
        },
      );

      only(
        amounts.neverPaid !== undefined || deposits,
        'el banco cobra al instante: no deja nada pendiente que anular',
        'correcto: cancel de un cobro pendiente lo deja `canceled` y es idempotente',
        async () => {
          const req = request(firstMethod, amounts.neverPaid ?? amounts.paid);
          await h.connector.createCharge(req, h.now());
          expect((await h.connector.cancel(req.reference, h.now())).status).toBe('canceled');
          expect((await h.connector.cancel(req.reference, h.now())).status).toBe('canceled');
          // La transferencia bancaria no tiene estado de anulación del lado del banco: se queda `pending` hasta vencer.
          expect((await h.connector.getStatus(req.reference, h.now())).status).toBe(deposits ? 'pending' : 'canceled');
        },
      );

      it('inválido: una referencia desconocida se rechaza de forma definitiva (ConnectorRejectedError), nunca se inventa un estado', async () => {
        await expect(h.connector.getStatus(newCharge(), h.now())).rejects.toBeInstanceOf(ConnectorRejectedError);
        await expect(h.connector.cancel(newCharge(), h.now())).rejects.toBeInstanceOf(ConnectorRejectedError);
      });

      only(spec.methods.length === 1, 'el conector declara varios medios', 'inválido: un medio que el conector no declara se rechaza', async () => {
        const other: Method = firstMethod === 'qr' ? 'card' : 'qr';
        await expect(h.connector.createCharge(request(other, amounts.paid), h.now())).rejects.toBeInstanceOf(ConnectorRejectedError);
      });
    });

    describe('resultados ambiguos y caída (regla 11: ambiguo ≠ fallo)', () => {
      only(amounts.ambiguous !== undefined, 'este banco no tiene escenario de timeout ambiguo', 'timeout ambiguo: ConnectorTimeoutError (la orden PUDO ejecutarse) y repetir la MISMA referencia devuelve el mismo cobro', async () => {
        const req = request(firstMethod, amounts.ambiguous as bigint);
        await expect(h.connector.createCharge(req, h.now())).rejects.toBeInstanceOf(ConnectorTimeoutError);
        const retry = await h.connector.createCharge(req, h.now());
        expect(retry.providerReference.length).toBeGreaterThan(0);
        expect((await h.connector.createCharge(req, h.now())).providerReference).toBe(retry.providerReference);
      });

      only(cap.canBeDown, 'este banco no se puede apagar', 'banco caído: createCharge lanza ConnectorUnavailableError (no se envió nada); la sonda lo marca abajo y, al volver, arriba', async () => {
        const setDown = h.setDown as (down: boolean) => Promise<void>;
        expect((await h.connector.probe(h.now())).ok).toBe(true);
        await setDown(true);
        if (cap.chargeNeedsBank) await expect(h.connector.createCharge(request(firstMethod, amounts.paid), h.now())).rejects.toBeInstanceOf(ConnectorUnavailableError);
        const down = await h.connector.probe(h.now());
        expect(down.ok).toBe(false);
        expect(down.reason).toBeDefined();
        await setDown(false);
        expect((await h.connector.probe(h.now())).ok).toBe(true);
      });

      only(amounts.declined !== undefined, 'este banco no tiene escenario de rechazo síncrono', 'rechazo síncrono: el importe «rechazado» devuelve `failed` con un código estable', async () => {
        const result = await h.connector.createCharge(request(firstMethod, amounts.declined as bigint), h.now());
        expect(result.status).toBe('failed');
        expect(result.failureCode).toBe('card_declined');
      });
    });

    describe('refund / getRefund', () => {
      only(cap.refunds, 'devolver una transferencia bancaria es una orden de pago saliente (no modelada)', 'correcto: reembolso parcial de un cobro cobrado, idempotente por referencia y consultable; el excedente se rechaza', async () => {
        const req = request(firstMethod, amounts.paid);
        await h.connector.createCharge(req, h.now());
        const refund = { reference: newRefund(), chargeReference: req.reference, amountMinor: req.amountMinor / 4n };
        const first = await h.connector.refund(refund, h.now());
        expect(first.status).toBe('captured');
        expect((await h.connector.refund(refund, h.now())).providerReference).toBe(first.providerReference);
        expect(await h.connector.getRefund?.(refund.reference, h.now())).toMatchObject({ status: 'captured', providerReference: first.providerReference });
        const over = await h.connector.refund({ reference: newRefund(), chargeReference: req.reference, amountMinor: req.amountMinor }, h.now());
        expect(over.status).toBe('failed');
        expect(over.failureCode).toBe('validation_failed');
      });

      only(cap.refunds, 'este conector no reembolsa', 'límite: getRefund de una referencia que el banco no tiene devuelve `not_found` EXPLÍCITO (no un error)', async () => {
        expect(await h.connector.getRefund?.(newRefund(), h.now())).toEqual({ status: 'not_found' });
      });

      it('inválido: reembolsar un cobro desconocido se rechaza; un conector que no reembolsa lo rechaza SIEMPRE, sin tocar nada', async () => {
        await expect(h.connector.refund({ reference: newRefund(), chargeReference: newCharge(), amountMinor: 100n }, h.now())).rejects.toBeInstanceOf(ConnectorRejectedError);
      });
    });

    describe('verifyCallback', () => {
      only(cap.callbacks, 'el banco de este conector no avisa por callback (se concilia por extracto)', 'correcto: un callback bien firmado se interpreta en un evento con su id, referencia, estado e importe', async () => {
        const reference = newCharge();
        const signed = await (h.signCallback as NonNullable<Harness['signCallback']>)({ id: 'evt_contrato0001', reference, status: 'captured', amountMinor: 10000n });
        const result = await h.connector.verifyCallback({ headers: signed.headers, rawBody: signed.rawBody, now: h.now() });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.events).toEqual([expect.objectContaining({ providerEventId: 'evt_contrato0001', chargeReference: reference, status: 'captured', amountMinor: 10000n })]);
      });

      it('inválido: firma alterada, cuerpo alterado, sin cabeceras, repetición fuera de ventana o basura ⇒ ok:false (nunca se acepta); un conector sin callbacks los rechaza TODOS', async () => {
        if (cap.callbacks) {
          const signed = await (h.signCallback as NonNullable<Harness['signCallback']>)({ id: 'evt_contrato0002', reference: newCharge(), status: 'captured', amountMinor: 10000n });
          const sig = signed.headers['webhook-signature'] ?? '';
          const flipped = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA');
          expect((await h.connector.verifyCallback({ headers: { ...signed.headers, 'webhook-signature': flipped }, rawBody: signed.rawBody, now: h.now() })).ok).toBe(false);
          expect((await h.connector.verifyCallback({ headers: signed.headers, rawBody: Buffer.from(signed.rawBody.toString('utf8').replace('captured', 'failed__')), now: h.now() })).ok).toBe(false);
          expect((await h.connector.verifyCallback({ headers: {}, rawBody: signed.rawBody, now: h.now() })).ok).toBe(false);
          expect((await h.connector.verifyCallback({ headers: signed.headers, rawBody: signed.rawBody, now: new Date(h.now().getTime() + 3_600_000) })).ok).toBe(false);
        } else {
          expect((await h.connector.verifyCallback({ headers: { 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AAAA' }, rawBody: Buffer.from('{}'), now: h.now() })).ok).toBe(false);
        }
        expect((await h.connector.verifyCallback({ headers: {}, rawBody: Buffer.from('basura'), now: h.now() })).ok).toBe(false);
      });
    });

    describe('fetchStatement', () => {
      const window = () => ({ from: new Date(h.now().getTime() - 3_600_000), to: new Date(h.now().getTime() + 3_600_000) });
      const wellFormed = (lines: readonly StatementLine[]): void => {
        for (const line of lines) {
          expect(line.providerReference.length).toBeGreaterThan(0);
          expect(['credit', 'debit']).toContain(line.direction);
          expect(typeof line.amountMinor).toBe('bigint');
          expect(line.amountMinor).toBeGreaterThan(0n);
          expect(line.currency).toBe('BOB');
          expect(line.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      };

      only(cap.statementShowsCharges, 'el extracto de este conector son depósitos del pagador, no cobros', 'correcto: un cobro cobrado aparece como crédito con NUESTRA referencia y el importe cobrado', async () => {
        const req = request(firstMethod, amounts.paid);
        await h.connector.createCharge(req, h.now());
        const lines = await h.connector.fetchStatement(window());
        wellFormed(lines);
        expect(lines.filter((l) => l.ourReference === req.reference)).toEqual([expect.objectContaining({ direction: 'credit', amountMinor: req.amountMinor, currency: 'BOB' })]);
      });

      only(deposits, 'este conector cobra por callback/consulta, no por depósitos', 'correcto: el depósito del pagador con la referencia de las instrucciones aparece en el extracto (el banco no avisa)', async () => {
        const created = await h.connector.createCharge(request('bank_transfer', 20000n), h.now());
        const reference = (created.nextAction as { reference: string }).reference;
        expect((await h.connector.fetchStatement(window())).filter((l) => l.ourReference === reference)).toEqual([]);
        await (h.deposit as NonNullable<Harness['deposit']>)(reference, 20000n);
        const lines = (await h.connector.fetchStatement(window())).filter((l) => l.ourReference === reference);
        wellFormed(lines);
        expect(lines).toEqual([expect.objectContaining({ direction: 'credit', amountMinor: 20000n })]);
      });

      it('límite: una ventana vacía devuelve [] (no un error)', async () => {
        const future = { from: new Date(h.now().getTime() + 86_400_000), to: new Date(h.now().getTime() + 2 * 86_400_000) };
        expect(await h.connector.fetchStatement(future)).toEqual([]);
        // (La glosa que pueda traer el banco la descarta StatementsService antes de salir del servicio: `test/statements.spec.ts`.)
        for (const line of await h.connector.fetchStatement(window())) expect(line.description === undefined || line.description === null || typeof line.description === 'string').toBe(true);
      });

      only(cap.canBeDown, 'este banco no se puede apagar', 'inválido: con el banco caído el extracto lanza ConnectorUnavailableError (no devuelve [] como si no hubiera movimientos)', async () => {
        await (h.setDown as (down: boolean) => Promise<void>)(true);
        await expect(h.connector.fetchStatement(window())).rejects.toBeInstanceOf(ConnectorUnavailableError);
      });
    });

    describe('createTransfer / getTransfer', () => {
      only(cap.transfers, 'este conector no paga transferencias salientes', 'correcto: la orden se paga, es idempotente por referencia y se puede consultar; una desconocida da `not_found` EXPLÍCITO', async () => {
        const create = h.connector.createTransfer as NonNullable<Connector['createTransfer']>;
        const get = h.connector.getTransfer as NonNullable<Connector['getTransfer']>;
        const reference = newTransfer();
        const first = await create.call(h.connector, { reference, amountMinor: 250000n, destinationRef: 'dest_comercio_0001' }, h.now());
        expect(first.status).toBe('paid');
        expect((await create.call(h.connector, { reference, amountMinor: 250000n, destinationRef: 'dest_comercio_0001' }, h.now())).providerReference).toBe(first.providerReference);
        expect(await get.call(h.connector, reference, h.now())).toMatchObject({ status: 'paid', providerReference: first.providerReference });
        expect(await get.call(h.connector, newTransfer(), h.now())).toEqual({ status: 'not_found' });
      });

      only(cap.transfers, 'este conector no paga transferencias salientes', 'límite/inválido: Bs …01 la rechaza (`rejected_by_bank`); Bs …07 se EJECUTA y la respuesta se pierde (ambiguo), y la consulta demuestra que se pagó', async () => {
        const create = h.connector.createTransfer as NonNullable<Connector['createTransfer']>;
        const get = h.connector.getTransfer as NonNullable<Connector['getTransfer']>;
        const rejected = await create.call(h.connector, { reference: newTransfer(), amountMinor: 250001n, destinationRef: 'dest_comercio_0001' }, h.now());
        expect(rejected).toMatchObject({ status: 'failed', failureCode: 'rejected_by_bank' });
        const reference = newTransfer();
        await expect(create.call(h.connector, { reference, amountMinor: 250007n, destinationRef: 'dest_comercio_0001' }, h.now())).rejects.toBeInstanceOf(ConnectorTimeoutError);
        expect(await get.call(h.connector, reference, h.now())).toMatchObject({ status: 'paid' });
      });
    });
  });
}
