# Escenarios del banco simulado `pay-mockbank` (y del conector `mock`) — importes para E1–E8

> Capa sandbox (D-26). TODO es ficticio: ningún importe, referencia ni campo es de un banco real (Q-01, Q-11 siguen abiertas).
> La tabla la define `services/pay-mockbank/src/bank/scenarios.ts`; `services/pay-mockbank/test/escenarios-doc.spec.ts` falla si este archivo
> se desvía de ella. El conector `mock` en proceso (`pay-connectors`, sin `MOCKBANK_URL`) usa la MISMA tabla.

## Cómo se elige el escenario

El banco mira los **centavos** del importe: `amount_minor % 100`. Cualquier otro valor (10 a 99) se aprueba. Importe de ejemplo: Bs 100,0N = `10000 + N`.

| Centavos | Escenario | Importe de ejemplo (`amount_minor`) | Qué hace el banco |
|---|---|---|---|
| `00` | aprobado | `10000` | el callback `captured` se entrega enseguida |
| `01` | rechazado | `10001` | `failed` con `card_declined` de forma síncrona; nunca se paga |
| `02` | demorado | `10002` | pago y callback `MOCKBANK_DELAY_MS` después (5 s por defecto) |
| `03` | callback duplicado | `10003` | el mismo callback `captured` ×3 con el mismo id de evento |
| `04` | fuera de orden | `10004` | llega `captured` y DESPUÉS `authorized` |
| `05` | callback perdido | `10005` | nunca se entrega; solo la consulta de estado revela `captured` |
| `06` | banco caído | `10006` | `503 bank_unavailable`, no crea nada (seguro reintentar) |
| `07` | timeout ambiguo | `10007` | crea el cobro y la conexión se corta sin responder |
| `08` | nunca pagado | `10008` | pasa a `expired` al llegar `expires_at` |
| `09` | extracto con diferencia | `10009` | cobra bien; el extracto trae Bs 1,00 menos |

**Transferencias salientes (payout):** `00`/otros pagada · `01` fallida `rejected_by_bank` · `02` en tránsito `MOCKBANK_DELAY_MS` · `06` banco caído (nada se envía) ·
`07` sin respuesta, `17` un proxy contesta 502 con HTML, `27` socket reseteado (en los tres la orden **se ejecuta**) · `08` en tránsito para siempre.

## Constantes para los flujos E4 y E8 (las que hoy tiene `e2e/lib/p2-bank.ts`)

Los valores coinciden con los de `e2e/lib/p2-bank.ts` (archivo de P2, que no se edita desde P4). Si P2 prefiere leerlos de acá, el bloque JSON de abajo es la fuente.

| Constante de `p2-bank.ts` | Valor | De dónde sale |
|---|---|---|
| `MOCK_QR_CENTS.approved` | `0` | fila `00` |
| `MOCK_QR_CENTS.statementMismatch` | `9` | fila `09` |
| `MOCK_TRANSFER_CENTS.paid` | `0` | payout pagado |
| `STATEMENT_MISMATCH_MINOR` | `100` | el extracto trae Bs 1,00 menos |
| `QR_GROSS_MATCHING` | `10000` | Bs 100,00 aprobado y conciliado sin diferencia |
| `QR_GROSS_STATEMENT_MISMATCH` | `10009` | Bs 100,09: el extracto informa `10009 − 100 = 9909` |
| `AVAILABLE_BEFORE_CUT` | `50000` | Bs 500,00: payout pagado (centavos `00`) |
| `BANK_TRANSFER_GROSS` | `20000` | E8: el pagador transfiere Bs 200,00 con la referencia correcta |
| `BANK_TRANSFER_WRONG_AMOUNT` | `19000` | E8: referencia correcta pero Bs 190,00 ⇒ el cobro NO se captura (excepción `amount_mismatch`) |

```json
{
  "scenarios_by_cents": { "approved": 0, "declined": 1, "delayed": 2, "duplicate_callback": 3, "out_of_order": 4, "lost_callback": 5, "down": 6, "ambiguous_timeout": 7, "never_paid": 8, "statement_mismatch": 9 },
  "statement_mismatch_minor": 100,
  "qr_gross_matching": 10000,
  "qr_gross_statement_mismatch": 10009,
  "available_before_cut": 50000,
  "bank_transfer_gross": 20000,
  "bank_transfer_wrong_amount": 19000
}
```

## E8 — el pagador transfiere al banco

`payerTransfersToBank({ reference, amountMinor })` de `p2-bank.ts` hoy lanza porque el banco de `bank_transfer` vivía dentro del proceso de `pay-connectors`. Con `pay-mockbank`:

1. `pay-connectors` arranca con `MOCKBANK_URL=http://127.0.0.1:<puerto de pay-mockbank>` y el secreto del mock compartido; `pay-mockbank` con `MOCKBANK_CALLBACK_URL=…/callbacks/mock` y `PAY_QR_URL`.
2. El cobro con `method: "bank_transfer"` devuelve `next_action.reference` (`TR…`, 12 caracteres): la referencia de las instrucciones.
3. El pagador deposita — **el único punto a cambiar en `p2-bank.ts`**:

   ```http
   POST {MOCKBANK_URL}/sandbox/payer/transfer-in
   X-Service-Id: pay-mockbank
   Content-Type: application/json

   { "reference": "<next_action.reference>", "amount_minor": 20000 }
   ```

   Respuesta `200 { bank_reference, reference, amount_minor, account: "transfers" }`. Por consola: `mockbank transfer <referencia> <centavos>`.
4. El banco **no avisa**: la línea aparece en el extracto de la cuenta `transfers` (`GET /sandbox/statement?account=transfers`). `pay-connectors` la concilia (`StatementsService.reconcile`, temporizador `RECONCILE_INTERVAL_MS`, o `POST /statements` según el arnés) y, con referencia e importe exactos, **captura** el cobro. Con otro importe queda una excepción `amount_mismatch` y el cobro sigue pendiente.

`GET /statements` de `pay-connectors` devuelve ahora `payment_intent_id` (`pi_…`) en cada línea emparejada con un cobro: `pay-settlement` cruza extracto y ledger por ahí.
