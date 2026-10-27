import type { Db } from './db';

/** Hechos que no se resuelven solos y quedan para una persona (conciliación). No guarda datos de personas. */
export const contradictionsRepo = {
  /** @returns `true` si se registró; `false` si ese mismo evento ya estaba registrado. */
  async record(db: Db, input: { paymentIntentId: string; currentStatus: string; incomingStatus: string; sourceEventId: string; kind: string; reason: string }): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO intent_contradictions (payment_intent_id, current_status, incoming_status, source_event_id, kind, reason)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (payment_intent_id, source_event_id) DO NOTHING`,
      [input.paymentIntentId, input.currentStatus, input.incomingStatus, input.sourceEventId, input.kind, input.reason],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async count(db: Db, paymentIntentId: string): Promise<number> {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM intent_contradictions WHERE payment_intent_id = $1', [paymentIntentId]);
    return Number(rows[0]?.n ?? 0);
  },
};
