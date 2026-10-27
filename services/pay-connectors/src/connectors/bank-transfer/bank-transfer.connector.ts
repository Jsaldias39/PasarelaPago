import type { Pool } from 'pg';
import {
  ConnectorRejectedError,
  type Connector,
  type Method,
  type Mode,
  type ProbeResult,
  type ProviderChargeRequest,
  type ProviderChargeResult,
  type ProviderRefundResult,
  type ProviderStatus,
  type ProviderStatusResult,
  type StatementLine,
  type VerifyCallbackResult,
} from '../../domain/connector';
import { newTransferReference } from '../../ids';

/** Dónde vive la referencia única de cada transferencia. La implementación real es una tabla; las pruebas pueden usar otra. */
export interface TransferReferenceStore {
  getOrCreate(chargeId: string, expiresAt: Date): Promise<{ reference: string; expiresAt: Date }>;
  find(chargeId: string): Promise<{ reference: string; expiresAt: Date } | null>;
}

/** De dónde sale el extracto del banco. En producción: el Banco Mercantil (formato sin definir). En sandbox: el banco simulado. */
export interface StatementSource {
  fetch(range: { from: Date; to: Date }): Promise<readonly StatementLine[]>;
  probe(): Promise<ProbeResult>;
}

export class DbTransferReferenceStore implements TransferReferenceStore {
  constructor(private readonly pool: Pool) {}

  async getOrCreate(chargeId: string, expiresAt: Date): Promise<{ reference: string; expiresAt: Date }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.find(chargeId);
      if (existing) return existing;
      // `ON CONFLICT DO NOTHING` sin destino: cubre tanto una referencia repetida (azar) como el mismo cobro creado en paralelo.
      await this.pool.query('INSERT INTO bank_transfer_references (reference, charge_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [newTransferReference(), chargeId, expiresAt]);
    }
    throw new Error('No se pudo asignar una referencia de transferencia única');
  }

  async find(chargeId: string): Promise<{ reference: string; expiresAt: Date } | null> {
    const found = await this.pool.query('SELECT reference, expires_at FROM bank_transfer_references WHERE charge_id = $1', [chargeId]);
    return found.rows[0] ? { reference: found.rows[0].reference as string, expiresAt: found.rows[0].expires_at as Date } : null;
  }
}

/**
 * Transferencia bancaria conciliada por extracto (D-03). El pagador transfiere con una referencia única; el banco no avisa:
 * el cobro pasa a `captured` cuando el `StatementReconciler` encuentra el crédito con esa referencia y el importe exacto.
 * Por eso `verifyCallback` rechaza todo y `getStatus` solo distingue «abierto» de «vencido».
 *
 * LÍMITE: devolver una transferencia es una orden de pago saliente, que no está modelada acá. `refund` la rechaza.
 */
export class BankTransferConnector implements Connector {
  readonly code = 'bank_transfer' as const;
  readonly methods: readonly Method[] = ['bank_transfer'];

  constructor(
    readonly mode: Mode,
    private readonly references: TransferReferenceStore,
    private readonly source: StatementSource,
    /** Cuenta recaudadora que ESTE conector informa al pagador (con dos bancos en el ruteo, solo el conector sabe cuál). Opcional hasta T-03. */
    private readonly account?: { readonly bankName: string; readonly accountHolder: string; readonly accountNumber: string },
  ) {}

  async createCharge(request: ProviderChargeRequest): Promise<ProviderChargeResult> {
    if (request.method !== 'bank_transfer') throw new ConnectorRejectedError('validation_failed', 'medio no soportado');
    const stored = await this.references.getOrCreate(request.reference, request.expiresAt);
    return {
      providerReference: stored.reference,
      status: 'pending',
      nextAction: {
        type: 'bank_transfer_instructions',
        reference: stored.reference,
        ...(this.account && { bank_name: this.account.bankName, account_holder: this.account.accountHolder, account_number: this.account.accountNumber }),
      },
    };
  }

  async getStatus(reference: string, now: Date): Promise<ProviderStatusResult> {
    const stored = await this.references.find(reference);
    if (!stored) throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    return now.getTime() >= stored.expiresAt.getTime() ? { status: 'expired', occurredAt: stored.expiresAt } : { status: 'pending', occurredAt: now };
  }

  async cancel(reference: string): Promise<{ status: ProviderStatus }> {
    if (!(await this.references.find(reference))) throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    return { status: 'canceled' };
  }

  async refund(): Promise<ProviderRefundResult> {
    throw new ConnectorRejectedError('validation_failed', 'la devolución de una transferencia es una orden de pago saliente (no modelada)');
  }

  async verifyCallback(): Promise<VerifyCallbackResult> {
    return { ok: false }; // el banco no notifica: se concilia por extracto
  }

  fetchStatement(range: { from: Date; to: Date }): Promise<readonly StatementLine[]> {
    return this.source.fetch(range);
  }

  probe(): Promise<ProbeResult> {
    return this.source.probe();
  }
}
