/** Mapa de lo que el código de pay-vault asume de su esquema. Ninguna columna puede contener un número de tarjeta, un CVV ni el titular. Lo compara el verificador de deriva (test/schema.drift.spec.ts, regla 97.2). */
export interface ColumnShape {
  readonly type: string;
  readonly nullable: boolean;
}

export const VAULT_SCHEMA_MAP: Readonly<Record<string, Readonly<Record<string, ColumnShape>>>> = {
  capture_sessions: {
    id: { type: 'text', nullable: false },
    merchant_id: { type: 'text', nullable: false },
    payment_intent_id: { type: 'text', nullable: true },
    save_card: { type: 'boolean', nullable: false },
    status: { type: 'text', nullable: false },
    capture_url: { type: 'text', nullable: false },
    token: { type: 'text', nullable: true },
    expires_at: { type: 'timestamp with time zone', nullable: false },
    created_at: { type: 'timestamp with time zone', nullable: false },
    completed_at: { type: 'timestamp with time zone', nullable: true },
  },
  card_tokens: {
    token: { type: 'text', nullable: false },
    merchant_id: { type: 'text', nullable: false },
    brand: { type: 'text', nullable: false },
    last4: { type: 'text', nullable: false },
    exp_month: { type: 'smallint', nullable: false },
    exp_year: { type: 'smallint', nullable: false },
    fingerprint: { type: 'text', nullable: false },
    single_use: { type: 'boolean', nullable: false },
    bound_charge_id: { type: 'text', nullable: true },
    deleted_at: { type: 'timestamp with time zone', nullable: true },
    created_at: { type: 'timestamp with time zone', nullable: false },
  },
  reveal_audit: {
    id: { type: 'bigint', nullable: false },
    token: { type: 'text', nullable: false },
    merchant_id: { type: 'text', nullable: false },
    charge_id: { type: 'text', nullable: false },
    caller: { type: 'text', nullable: false },
    outcome: { type: 'text', nullable: false },
    idempotency_key: { type: 'text', nullable: true },
    at: { type: 'timestamp with time zone', nullable: false },
  },
};
