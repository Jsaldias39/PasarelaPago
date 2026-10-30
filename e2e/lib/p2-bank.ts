import type { Stack } from '../stack.ts';

/**
 * Importes que disparan escenarios del banco simulado, para los flujos E4 y E8 (carril P2).
 *
 * Son los de `pay-mockbank` y del conector `mock` (docs/trabajo/ola-2/P4/ESCENARIOS.md, «escenarios deterministas por los CENTAVOS del importe»). Si P4 cambia la tabla,
 * se cambian ACÁ y los flujos no se tocan. Nada de esto es del banco real (Q-11).
 */

/** Centavos que eligen el escenario de un cobro QR en el conector `mock`. */
export const MOCK_QR_CENTS = {
  /** Aprobado: el callback `captured` llega enseguida. */
  approved: 0,
  /** Extracto con diferencia: el extracto del banco informa Bs 1,00 MENOS que lo cobrado. */
  statementMismatch: 9,
} as const;

/** Centavos que eligen el escenario de una transferencia SALIENTE (payout) en el conector `mock`. */
export const MOCK_TRANSFER_CENTS = {
  /** Pagada (y cualquier otro valor no especial). */
  paid: 0,
} as const;

/** Lo que el escenario `statementMismatch` resta al extracto (Bs 1,00). */
export const STATEMENT_MISMATCH_MINOR = 100;

/** Cobro QR aprobado y conciliado sin diferencia: Bs 100,00. */
export const QR_GROSS_MATCHING = 10_000 + MOCK_QR_CENTS.approved;
/** Cobro QR cuyo extracto trae Bs 1,00 menos: Bs 100,09. */
export const QR_GROSS_STATEMENT_MISMATCH = 10_000 + MOCK_QR_CENTS.statementMismatch;
/** Dinero que el comercio ya tiene DISPONIBLE al cortar y que el corte paga: Bs 500,00 (centavos `00` ⇒ la transferencia sale pagada). */
export const AVAILABLE_BEFORE_CUT = 50_000 + MOCK_TRANSFER_CENTS.paid;

/** E8: importe de la transferencia bancaria que el pagador hace con la referencia correcta (Bs 200,00). */
export const BANK_TRANSFER_GROSS = 20_000;
/** E8: crédito del extracto con la referencia correcta pero OTRO importe (Bs 190,00): no debe capturar el cobro. */
export const BANK_TRANSFER_WRONG_AMOUNT = 19_000;

/**
 * El pagador transfiere al banco con la referencia de la instrucción (`bank_transfer_instructions.reference`) y el banco la deja en su extracto.
 *
 * Contra el stack con `pay-mockbank` (`startStack({ mockbank: true })`): `POST /sandbox/payer/transfer-in` (docs/trabajo/ola-2/P4/ESCENARIOS.md § E8). El banco NO
 * avisa a nadie: la línea aparece en el extracto de la cuenta `transfers` y el conector la descubre al conciliar. Falla diciendo por qué si el banco no
 * contesta 200 (no se inventa un depósito).
 */
export async function payerTransfersToBank(stack: Stack, input: { reference: string; amountMinor: number }): Promise<{ bankReference: string }> {
  const res = await stack.callAs('pay-mockbank', 'pay-mockbank', 'POST', '/sandbox/payer/transfer-in', {
    payMode: 'test',
    json: { reference: input.reference, amount_minor: input.amountMinor },
  });
  if (res.status !== 200 && res.status !== 201) {
    // La respuesta real es 201 (Nest, POST sin @HttpCode); ESCENARIOS.md dice 200: se aceptan ambas y se avisa a P4.
    throw new Error(`pay-mockbank no aceptó el depósito de ${input.amountMinor} centavos con la referencia ${input.reference}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
  return { bankReference: (res.json as { bank_reference: string }).bank_reference };
}
