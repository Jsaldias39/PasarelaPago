import { createIsolatedDatabase } from '@pay/testing';
import { SecretBox } from '../src/crypto/secret-box';
import { InProcessEngine } from '../src/engine/in-process.engine';
import { describeEngineContract } from './engine-contract';
import { SQL_FILES, TestClock } from './harness';

describeEngineContract('InProcessEngine [DOBLE de Svix]', async () => {
  const db = await createIsolatedDatabase(SQL_FILES);
  return { engine: new InProcessEngine(new SecretBox(Buffer.alloc(32, 9)), new TestClock(), { rotationGraceMs: 1000 }), db: db.pool, dispose: () => db.drop() };
});
