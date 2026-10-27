import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { newId, sqlState, withTx } from '../db';
import { iso } from '../merchants/events';
import { lockMerchant } from '../merchants/merchants.service';

@Injectable()
export class LegalService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Publica una versión del contrato legal. Las versiones solo se agregan: `version` tiene que ser la siguiente. */
  async publishVersion(input: { version: number; text_sha256: string; effective_from?: string }, operatorSub: string) {
    return withTx(this.pool, async (client) => {
      await client.query('LOCK TABLE contract_versions IN SHARE ROW EXCLUSIVE MODE');
      const last = await client.query('SELECT version, effective_from FROM contract_versions ORDER BY version DESC LIMIT 1');
      const expected = last.rows.length === 0 ? 1 : Number(last.rows[0].version) + 1;
      if (input.version !== expected) {
        throw new ProblemError('validation_failed', { detail: `La próxima versión es ${expected}`, errors: [{ field: 'version', code: 'not_next' }] });
      }
      const effectiveFrom = input.effective_from ? new Date(input.effective_from) : new Date();
      if (last.rows.length > 0 && effectiveFrom < (last.rows[0].effective_from as Date)) {
        throw new ProblemError('validation_failed', { errors: [{ field: 'effective_from', code: 'before_previous_version' }] });
      }
      const { rows } = await client.query(
        'INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES ($1, $2, $3, $4) RETURNING published_at',
        [input.version, input.text_sha256, effectiveFrom, operatorSub],
      );
      return { object: 'contract_version' as const, version: input.version, text_sha256: input.text_sha256, effective_from: iso(effectiveFrom), published_at: iso(rows[0].published_at as Date) };
    });
  }

  /**
   * Registra la aceptación de una versión (REQ-P5-2). Es inmutable: queda quién la declaró (`accepted_by_ref`), quién la
   * registró (el `sub` de la credencial), cuándo y el hash del texto aceptado.
   */
  async accept(merchantId: string, input: { version: number; accepted_by_ref: string }, operatorSub: string) {
    return withTx(this.pool, async (client) => {
      const merchant = await lockMerchant(client, merchantId);
      if (merchant.status === 'closed') throw new ProblemError('invalid_state_transition', { errors: [{ field: 'status', code: 'from_closed' }] });
      const version = await client.query('SELECT text_sha256, effective_from FROM contract_versions WHERE version = $1', [input.version]);
      if (version.rows.length === 0) throw new ProblemError('validation_failed', { errors: [{ field: 'version', code: 'unknown' }] });
      if ((version.rows[0].effective_from as Date) > new Date()) throw new ProblemError('validation_failed', { errors: [{ field: 'version', code: 'not_yet_effective' }] });
      const id = newId('ca');
      try {
        const { rows } = await client.query(
          `INSERT INTO contract_acceptances (id, merchant_id, version, text_sha256, accepted_by_ref, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING accepted_at`,
          [id, merchantId, input.version, version.rows[0].text_sha256, input.accepted_by_ref, operatorSub],
        );
        return {
          id,
          object: 'contract_acceptance' as const,
          merchant_id: merchantId,
          version: input.version,
          text_sha256: version.rows[0].text_sha256 as string,
          accepted_by_ref: input.accepted_by_ref,
          recorded_by: operatorSub,
          accepted_at: iso(rows[0].accepted_at as Date),
        };
      } catch (error) {
        if (sqlState(error) === '23505') throw new ProblemError('invalid_state_transition', { detail: 'Esa versión ya fue aceptada', errors: [{ field: 'version', code: 'already_accepted' }] });
        throw error;
      }
    });
  }
}
