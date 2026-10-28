import 'reflect-metadata';
import path from 'node:path';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createIsolatedDatabase, loadContract, type ContractValidator, type IsolatedDatabase } from '@pay/testing';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { FakeVaultBackend } from '../../src/backend/fake-vault-backend';
import { ProblemFilter } from '../../src/problem.filter';
import { VaultController } from '../../src/vault/vault.controller';
import { VaultService } from '../../src/vault/vault.service';

const root = process.cwd();
// DDL generado por el modelo (D-18), vendorizado con `scripts/vendor-model-sql.sh`; ya trae la tabla de idempotencia.
export const SQL_FILES = [path.join(root, 'sql/ddl.sql')];

export const MC = 'mc_merchant00001';
export const MC2 = 'mc_merchant00002';
export const PAYMENTS = { 'x-service-id': 'pay-payments' } as const;
export const CONNECTORS = { 'x-service-id': 'pay-connectors' } as const;

export interface VaultTest {
  readonly db: IsolatedDatabase;
  readonly backend: FakeVaultBackend;
  readonly service: VaultService;
  readonly app: INestApplication;
  readonly contract: ContractValidator;
  clock: { now: Date };
  close(): Promise<void>;
}

export async function startVault(): Promise<VaultTest> {
  const db = await createIsolatedDatabase(SQL_FILES);
  const backend = new FakeVaultBackend();
  const clock = { now: new Date() };
  const service = new VaultService(db.pool as never, backend, () => clock.now);
  const moduleRef = await Test.createTestingModule({
    controllers: [VaultController],
    providers: [{ provide: VaultService, useValue: service }, { provide: APP_GUARD, useClass: ServiceIdentityGuard }, { provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const contract = await loadContract(path.join(root, '../../contracts/openapi/internal-vault-v1.yaml'));
  return { db, backend, service, app, contract, clock, async close() { await app.close(); await db.drop(); } };
}

export function routesOf(controller: { prototype: Record<string, unknown> }): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined)
    .map((name) => {
      const handler = proto[name] as object;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      return `${method} /${String(Reflect.getMetadata(PATH_METADATA, handler)).replace(/:[A-Za-z_]+/g, '{}')}`;
    })
    .sort();
}
export const normalizeOps = (ops: string[]): string[] => ops.map((op) => op.replace(/\{[^}]+\}/g, '{}')).sort();

/** Todo lo que el proceso escribe a stdout/stderr mientras dura `work`: sirve para comprobar que ningún log trae datos de tarjeta. */
export async function captureOutput<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const spy = (original: typeof out) => ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof out;
  process.stdout.write = spy(out);
  process.stderr.write = spy(err);
  let result: T;
  try {
    result = await work();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { result, output: chunks.join('') };
}
