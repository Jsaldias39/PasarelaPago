# @pay/money

Aritmética exacta de importes (sin coma flotante) y cálculo de comisiones. Dueño: P1.

- `decimal-money.ts`, `payment-money.ts` y sus specs: **reciclados sin cambiar ninguna aserción** de
  `mdavila-2001/mantra-core-health-api` (`src/common/money/decimal-money.ts` y
  `src/modules/payments/services/payment-money.ts`, `origin/dev` @ `4e64353a`). Único cambio: el import de `sumarDecimales`, que la API
  reexporta como alias de `addDecimals` (`src/common/index.ts:208`). Operan con importes como cadena decimal (para el borde de la API).
- `minor.ts`: nuevo. Unidades menores en `bigint` y `splitFee` (D-07, D-20).

Regla de redondeo (D-20): se redondea half-up el **neto** del comercio; la comisión es el resto.
El centavo de un empate exacto queda del lado del comercio y `comisión + neto = bruto` siempre.
