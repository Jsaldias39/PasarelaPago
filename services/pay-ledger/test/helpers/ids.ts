import { accountTbId as accountId, holdGroupId, holdTbId as holdId, legTbId as legId, txGroupId } from '../../src/ledger/ids';
import type { PayMode } from '../../src/ledger/mode';

/** Las pruebas de siempre corren en modo `test`; las de aislamiento pasan el modo explícito. */
export const TEST_MODE: PayMode = 'test';
export const accountTbId = (name: string, mode: PayMode = TEST_MODE) => accountId(mode, name);
export const legTbId = (ref: string, attempt: number, index: number, part: 'main' | 'debt' = 'main', mode: PayMode = TEST_MODE) => legId(mode, ref, attempt, index, part);
export const holdTbId = (ref: string, attempt: number, mode: PayMode = TEST_MODE) => holdId(mode, ref, attempt);

/**
 * Marca (`user_data`) que el servicio le pone a las transferencias de un asiento / de una retención. Las pruebas que simulan una caída «TigerBeetle aplicó y
 * Postgres no registró» crean la transferencia a mano: tiene que ser EXACTAMENTE la que habría mandado el servicio, o el reintento chocaría con `exists_with_different_user_data`.
 */
export const txMeta = (ref: string, attempt: number, mode: PayMode = TEST_MODE) => ({ mode, group: txGroupId(mode, ref, attempt) });
export const holdMeta = (ref: string, attempt: number, mode: PayMode = TEST_MODE) => ({ mode, group: holdGroupId(mode, ref, attempt) });
