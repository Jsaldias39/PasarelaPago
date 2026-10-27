export type QrKind = 'static' | 'dynamic';
export type QrStatus = 'active' | 'expired' | 'canceled';

export interface QrRow {
  id: string;
  kind: QrKind;
  merchant_id: string;
  payment_intent_id: string | null;
  reference: string;
  amount_minor: string | null;
  currency: string;
  payload: string;
  expires_at: Date | null;
  canceled_at: Date | null;
  created_at: Date;
}

/** Cuerpo de respuesta de un QR (contrato: contracts/openapi/internal-qr-v1.yaml). */
export interface QrView {
  id: string;
  object: 'qr';
  kind: QrKind;
  merchant_id: string;
  payment_intent_id: string | null;
  reference: string;
  amount_minor: number | null;
  currency: 'BOB';
  payload: string;
  status: QrStatus;
  expires_at: string | null;
  created_at: string;
}
