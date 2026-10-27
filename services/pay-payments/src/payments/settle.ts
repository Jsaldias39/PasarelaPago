import type { Deps } from '../deps';
import { emitIntentEvent, type IntentEventType } from '../events/emit';
import { intentsRepo, type IntentRow } from '../persistence/intents.repo';

const EVENT_FOR: Record<'succeeded' | 'failed' | 'canceled' | 'expired', IntentEventType> = {
  succeeded: 'payment_intent.succeeded',
  failed: 'payment_intent.failed',
  canceled: 'payment_intent.canceled',
  expired: 'payment_intent.expired',
};

/**
 * Lleva el intento a un estado terminal con precondición en la escritura (CAS sobre `status`) y publica el evento en la
 * MISMA transacción (outbox). Si alguien se adelantó devuelve el estado actual sin publicar nada: un intento termina en UN
 * solo estado y el evento sale una sola vez.
 */
export async function settleIntent(
  deps: Pick<Deps, 'tx'>,
  intentId: string,
  to: 'succeeded' | 'failed' | 'canceled' | 'expired',
  patch: { failureCode?: string; ledgerTransferId?: string } = {},
): Promise<{ intent: IntentRow; changed: boolean }> {
  return deps.tx(async (db) => {
    const row = await intentsRepo.transition(db, intentId, ['processing', 'requires_action'], to, { ...patch, nextAction: null });
    if (!row) {
      const current = await intentsRepo.byId(db, intentId);
      if (!current) throw new Error(`El intento ${intentId} no existe`);
      return { intent: current, changed: false };
    }
    await emitIntentEvent(db, EVENT_FOR[to], row);
    return { intent: row, changed: true };
  });
}
