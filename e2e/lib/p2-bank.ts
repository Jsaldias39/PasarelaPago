/**
 * Importes que disparan escenarios del banco simulado, para los flujos E4 y E8 (carril P2).
 *
 * HOY son los del conector `mock` (README de pay-connectors, «escenarios deterministas por los CENTAVOS del importe»). Los define de verdad
 * `pay-mockbank` (P4.H4.M3, en construcción): cuando exista, se cambian ACÁ y los flujos no se tocan. Nada de esto es del banco real (Q-11).
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
 * NO SE PUEDE HACER HOY contra el stack real: el extracto de `bank_transfer` sale de un banco simulado que vive DENTRO del proceso de
 * `pay-connectors` (`TRANSFER_BANK`, solo `injectStatementLine` en el código) y no expone ningún endpoint para inyectarle un depósito. Lo
 * resuelve `pay-mockbank` (P4.H4.M3). Esta función es el ÚNICO punto a cambiar cuando exista; mientras tanto falla con un mensaje que dice por qué,
 * en lugar de inventar una API que no existe.
 */
export async function payerTransfersToBank(input: { reference: string; amountMinor: number }): Promise<never> {
  throw new Error(
    `E8 necesita pay-mockbank (P4.H4.M3, en construcción): hoy no hay forma de que el pagador deposite ${input.amountMinor} centavos con la referencia ${input.reference} ` +
      'en el banco simulado del stack (vive dentro del proceso de pay-connectors). Implementar acá la llamada a pay-mockbank cuando exista.',
  );
}
