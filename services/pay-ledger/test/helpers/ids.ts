import { accountTbId as accountId, holdTbId as holdId, legTbId as legId } from '../../src/ledger/ids';
import type { PayMode } from '../../src/ledger/mode';

/** Las pruebas de siempre corren en modo `test`; las de aislamiento pasan el modo explícito. */
export const TEST_MODE: PayMode = 'test';
export const accountTbId = (name: string, mode: PayMode = TEST_MODE) => accountId(mode, name);
export const legTbId = (ref: string, attempt: number, index: number, part: 'main' | 'debt' = 'main', mode: PayMode = TEST_MODE) => legId(mode, ref, attempt, index, part);
export const holdTbId = (ref: string, attempt: number, mode: PayMode = TEST_MODE) => holdId(mode, ref, attempt);
