import type { NextAction as ConnectorNextAction } from '../clients/connectors.client';

/** Forma pública de `next_action` (`public-v1.yaml#/components/schemas/NextAction`). */
export type PublicNextAction =
  | { type: 'display_qr'; qr: { payload: string; expires_at: string } }
  | { type: 'bank_transfer_instructions'; bank_transfer: { reference: string; bank_name: string; account_holder: string; account_number: string } }
  | { type: 'redirect_to_card_form'; url: string };

/** Lo que se guarda en `payment_intents.next_action`: ya en forma pública, para devolverlo sin reconstruir. */
export function toPublicNextAction(
  action: ConnectorNextAction,
  fallbackExpiresAt: Date,
  bank?: { bankName: string; accountHolder: string; accountNumber: string },
): PublicNextAction | null {
  switch (action.type) {
    case 'display_qr':
      return { type: 'display_qr', qr: { payload: action.payload, expires_at: action.expires_at ?? fallbackExpiresAt.toISOString() } };
    case 'redirect_to_card_form':
      return { type: 'redirect_to_card_form', url: action.url };
    case 'bank_transfer_instructions':
      // La cuenta recaudadora la informa el CONECTOR que atiende el cobro (con dos bancos solo él sabe cuál). `BANK_TRANSFER_*` es solo
      // un respaldo hasta que exista la cuenta (T-03). Sin ninguna de las dos no se inventan datos bancarios.
      if (action.bank_name && action.account_holder && action.account_number) {
        return { type: 'bank_transfer_instructions', bank_transfer: { reference: action.reference, bank_name: action.bank_name, account_holder: action.account_holder, account_number: action.account_number } };
      }
      if (!bank) return null;
      return { type: 'bank_transfer_instructions', bank_transfer: { reference: action.reference, bank_name: bank.bankName, account_holder: bank.accountHolder, account_number: bank.accountNumber } };
  }
}
