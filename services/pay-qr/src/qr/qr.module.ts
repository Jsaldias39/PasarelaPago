import { Module } from '@nestjs/common';
import { IdempotencyStore } from '@pay/idempotency';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { ModeGate } from './pay-mode';
import { QrController } from './qr.controller';
import { QrService } from './qr.service';

@Module({
  controllers: [QrController],
  providers: [ModeGate, QrService, { provide: IdempotencyStore, inject: [PG_POOL], useFactory: (pool: Pool) => new IdempotencyStore(pool) }],
})
export class QrModule {}
