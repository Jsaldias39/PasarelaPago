import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { newId, withTx } from '../db';
import { iso } from '../merchants/events';
import { type KycKind, MerchantsService, REQUIRED_KYC_KINDS, lockMerchant } from '../merchants/merchants.service';
import { SETTINGS, type Settings } from '../settings';
import { detectType } from './file-type';
import { OBJECT_STORE, type ObjectStore } from './object-store';

export interface KycDocumentView {
  id: string;
  object: 'kyc_document';
  merchant_id: string;
  kind: KycKind;
  detected_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_at: string;
}

@Injectable()
export class KycService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly merchants: MerchantsService,
  ) {}

  /**
   * Guarda un documento (REQ-P5-8). El tipo se decide por los primeros bytes, el tamaño se acota, el archivo va al
   * almacén de objetos y en la base queda solo su clave, su hash y su tipo.
   */
  async uploadDocument(merchantId: string, kind: KycKind, file: Buffer, operatorSub: string): Promise<KycDocumentView> {
    if (!REQUIRED_KYC_KINDS.includes(kind)) {
      throw new ProblemError('validation_failed', { errors: [{ field: 'kind', code: 'unknown_kind' }] });
    }
    if (file.length === 0) throw new ProblemError('validation_failed', { errors: [{ field: 'file', code: 'empty' }] });
    if (file.length > this.settings.kycMaxBytes) {
      throw new ProblemError('validation_failed', { detail: 'El archivo supera el tamaño máximo', errors: [{ field: 'file', code: 'too_large' }] });
    }
    const detected = detectType(file);
    if (!detected) {
      throw new ProblemError('validation_failed', { detail: 'El archivo no es un PDF, PNG ni JPEG', errors: [{ field: 'file', code: 'unsupported_type' }] });
    }
    const id = newId('kd');
    const objectKey = `kyc/${merchantId}/${id}`;
    const sha256 = createHash('sha256').update(file).digest('hex');
    // Primero se verifica que el comercio exista y no esté cerrado; recién después se escribe el objeto.
    await withTx(this.pool, async (client) => {
      const merchant = await lockMerchant(client, merchantId);
      if (merchant.status === 'closed') throw new ProblemError('invalid_state_transition', { errors: [{ field: 'status', code: 'from_closed' }] });
    });
    await this.store.put(objectKey, file);
    try {
      const uploadedAt = await withTx(this.pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO kyc_documents (id, merchant_id, kind, object_key, sha256, size_bytes, detected_type, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING uploaded_at`,
          [id, merchantId, kind, objectKey, sha256, file.length, detected, operatorSub],
        );
        return rows[0].uploaded_at as Date;
      });
      return { id, object: 'kyc_document', merchant_id: merchantId, kind, detected_type: detected, size_bytes: file.length, sha256, uploaded_at: iso(uploadedAt) };
    } catch (error) {
      await this.store.delete(objectKey); // no dejar un objeto huérfano si la base rechazó la fila
      throw error;
    }
  }

  /**
   * Decide el KYC. Aprobar exige los 6 documentos del alta legal y un nivel de riesgo; sin eso, 409 con lo que falta.
   */
  async review(merchantId: string, decision: 'in_review' | 'approved' | 'rejected', riskLevel: string | undefined, note: string | undefined, operatorSub: string) {
    await withTx(this.pool, async (client) => {
      await lockMerchant(client, merchantId);
      if (decision === 'approved') {
        const errors: { field: string; code: string }[] = [];
        const { rows } = await client.query('SELECT DISTINCT kind FROM kyc_documents WHERE merchant_id = $1', [merchantId]);
        const present = new Set(rows.map((r) => r.kind as string));
        for (const kind of REQUIRED_KYC_KINDS) if (!present.has(kind)) errors.push({ field: `documents.${kind}`, code: 'missing' });
        if (!riskLevel) errors.push({ field: 'risk_level', code: 'required_to_approve' });
        if (errors.length > 0) throw new ProblemError('invalid_state_transition', { detail: 'No se puede aprobar el KYC', errors });
      }
      await client.query(
        `UPDATE merchant_kyc SET status = $2, risk_level = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5, updated_at = now() WHERE merchant_id = $1`,
        [merchantId, decision, riskLevel ?? null, operatorSub, note ?? null],
      );
    });
    return this.merchants.view(this.pool, merchantId);
  }
}
