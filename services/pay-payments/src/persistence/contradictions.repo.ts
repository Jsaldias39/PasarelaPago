import { enqueue, newCloudEvent } from '@pay/outbox';
import type { Db } from './db';

/**
 * Hechos que no se resuelven solos y quedan para una persona (conciliación): una contradicción del conector o un resultado ambiguo
 * (CLAUDE.md regla 11). Se guardan Y se publican como `payment_intent.contradiction_detected` en la MISMA transacción (outbox):
 * `pay-settlement` los consume. No lleva datos de personas.
 */
export const contradictionsRepo = {
  /** @returns `true` si se registró (y se publicó); `false` si ese mismo hecho ya estaba registrado (no se publica dos veces). */
  async record(db: Db, input: { paymentIntentId: string; currentStatus: string; incomingStatus: string; sourceEventId: string; kind: string; reason: string }): Promise<boolean> {
    const inserted = await db.query(
      `INSERT INTO intent_contradictions (payment_intent_id, current_status, incoming_status, source_event_id, kind, reason)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (payment_intent_id, source_event_id) DO NOTHING RETURNING detected_at`,
      [input.paymentIntentId, input.currentStatus, input.incomingStatus, input.sourceEventId, input.kind, input.reason],
    );
    const row = inserted.rows[0];
    if (!row) return false;
    const intent = await db.query('SELECT merchant_id, mode FROM payment_intents WHERE id = $1', [input.paymentIntentId]);
    const owner = intent.rows[0];
    if (owner) {
      const event = newCloudEvent({
        source: '/pay-payments',
        type: 'payment_intent.contradiction_detected',
        subject: input.paymentIntentId,
        merchantId: owner.merchant_id as string,
        data: {
          payment_intent_id: input.paymentIntentId,
          merchant_id: owner.merchant_id,
          kind: input.kind,
          current_status: input.currentStatus.slice(0, 40),
          incoming_status: input.incomingStatus.slice(0, 40),
          mode: owner.mode,
          detected_at: new Date(row.detected_at as string).toISOString(),
        },
      });
      await enqueue(db, event, { aggregateType: 'payment_intent', aggregateId: input.paymentIntentId });
    }
    return true;
  },
  async count(db: Db, paymentIntentId: string): Promise<number> {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM intent_contradictions WHERE payment_intent_id = $1', [paymentIntentId]);
    return Number(rows[0]?.n ?? 0);
  },
};
