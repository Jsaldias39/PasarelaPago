import { createIsolatedDatabase } from '@pay/testing';
import { SvixEngine } from '../../src/engine/svix/svix-engine';
import { describeEngineContract } from '../engine-contract';
import { SQL_FILES } from '../harness';
import { assertSvixReady, newSvixClient, svixToken } from './svix-env';

/** La MISMA suite de contrato que pasa el doble en proceso (test/engine-contract.spec.ts), ahora contra svix-server REAL y Postgres real. */
describeEngineContract('SvixEngine (svix-server real)', async () => {
  const client = newSvixClient(svixToken());
  await assertSvixReady(client);
  const db = await createIsolatedDatabase(SQL_FILES);
  return { engine: new SvixEngine(client, { rotationGraceSeconds: 60 }), db: db.pool, dispose: () => db.drop() };
});
