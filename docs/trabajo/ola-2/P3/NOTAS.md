# P3 · ola 2, tanda 2a — adaptación a los contratos (pay-payments, pay-vault)

Fuente: `docs/trabajo/ola-2/CONTRATOS.md` §3, §5 (lista «recomendadas» de pay-payments). Evidencia literal: [`evidencia/`](./evidencia/).
Gates: `typecheck`, `build`, `yarn eslint` (servicios) y `yarn lint` (raíz) en exit 0; `yarn test --maxWorkers=2` ×2 en pay-payments (18 suites, 226 pruebas, las dos veces) y en pay-vault (58 pruebas, las dos veces).

| # | Pedido | Qué se hizo | Dónde se prueba |
|---|---|---|---|
| 1 | `GET /refunds/{id}` | Ruta en `PaymentsController` → `PaymentsService.getRefund`; el ajeno y el de otro modo dan el mismo 404. | `ola2.contracts.spec.ts` §1; `intents.api.spec.ts` (rutas = contrato) |
| 2 | `risk_denied` / `payment_declined` | `deny`/`review` → `risk_denied`; 422 del proveedor y `card_declined` → `payment_declined` (`normalizeFailureCode`); `payment_method_unavailable` se publica como `validation_failed`. | §2, `payment.workflow.spec.ts` |
| 3 | Borrar `transferIdForEvent` | Los eventos citan `tx_` (cobro, contracargo) y `hd_` (reembolso) tal como los devolvió el ledger; sin id no hay evento de éxito. Una prueba verifica que el código no fabrica `tf_`. | §3 |
| 4 | Emitir `mock` | Sin tabla de traducción; un `simulator` de un productor sin migrar se normaliza a `mock` al LEERLO. | §4 |
| 5 | `refund_id` + `GET /refunds/{id}` del conector | El `re_…` viaja al conector, se guarda el `cr_…` (`refunds.connector_refund_id`) y, sin aviso, el workflow ESCALA una vez y CONSULTA cada `STATUS_INQUIRY_MS` (solo lectura). `stale`/`pending` no cambian nada; éxito confirma la retención, fallo la anula. Reemplaza la espera indefinida (P3-D11). | §5, `refunds.disputes.spec.ts` |
| 6 | Cuenta de `bank_transfer_instructions` | La informa el conector; `BANK_TRANSFER_*` es solo respaldo. Sin ninguna: se anula el cargo, el intento queda `failed` y el POST responde 422 `payment_method_unavailable`. | §6, `media.spec.ts` |
| 7 | `payment_intent.contradiction_detected` | `contradictionsRepo.record` publica el evento por outbox en la MISMA transacción, una vez por hecho (único por intento+origen). | §7 |
| 8 | D-28 | Columna `mode` en `payment_intents`, `refunds` y `disputes`; filtro `(comercio, modo)` en todo acceso; `X-Pay-Mode` obligatorio (403 si falta o no es `test\|live`) en las rutas públicas e internas; viaja a ledger y conectores; `mode` en todos los eventos; la clave de idempotencia y el id del intento incluyen el modo. | §8, `schema.drift.spec.ts` |
| 9 | Dobles contra `contracts/` | Los dobles ya cargaban los YAML de `contracts/openapi` y `contracts/asyncapi`; una prueba exige que ninguna ruta apunte a copias en `docs/`. El doble de conectores ahora implementa `GET /refunds/{id}`, `refund_id`, la cuenta recaudadora y `stale`; se prueba en los tres niveles. | §9, `doubles.spec.ts` |

## Lo que necesito de otros carriles (no toqué nada ajeno)
- **P4 (`pay-connectors`)**: que implemente de verdad `GET /refunds/{id}` (`cr_…`, `refresh`, `stale`), acepte `refund_id`, informe `bank_name/account_holder/account_number` y emita `mock` y `ch_/cr_`. Hasta entonces esas rutas se ejercitan solo contra el doble. Si el conector real devuelve un 404 con su cuerpo exacto para un `cr_` que él mismo creó, `pay-payments` lo trata como error de integración (escala y falla el workflow), no como «el reembolso no existe».
- **P1 (`pay-edge`)**: agregar `GET /refunds/{id}` a su tabla de rutas (ya está en su lista obligatoria) y reenviar `X-Pay-Mode`.
- **P5 (`pay-schedules`)**: mandar `X-Pay-Mode` en `POST /intents` y `GET /intents/{id}`: sin él ahora reciben 403.
- **P2 (`pay-settlement`)**: consumir `payment_intent.contradiction_detected` (tema `pay-payments.payment_intent.contradiction_detected`).

## Decisiones tomadas
- **Compatibilidad de ids**: `intentIdFor`/`refundIdFor` ahora derivan de `(comercio, modo:clave)`; los ids de intentos creados antes de este cambio ya no se re-derivan (solo hay datos de desarrollo).
- **Falla de la cuenta recaudadora**: no es un `failure_code` del catálogo, así que se guarda `payment_method_unavailable` en la fila y se publica/serializa como `validation_failed`; la respuesta del POST es el 422 del contrato.
- **P3-D11 queda reemplazada** por el punto 5. **PROP-2, 3, 4, 5, 7, 8, 9 (D-28), 10 y 11 de la ola 1 quedan aplicadas**; PROP-6 (disputas) sigue como decisión del dueño; PROP-13 y 14 son de plataforma.

## No cubierto
- Contra el conector, el ledger y el borde REALES (todo sigue contra dobles declarados que validan el contrato).
- `mode` en los consumidores de `connector.transaction.status_changed` (el evento no lo trae: se correlaciona por `payment_intent_id`/`refund_id`).
- El listado de reembolsos (diferido por el contrato).
- `fallos-p3.md` de la ola 1 lo reescribe la suite en cada corrida; se dejó como estaba en git.


# Tanda 2b

Evidencia: `evidencia/2b-*.txt` (typecheck, build, `yarn eslint` y `yarn lint` de la raíz en exit 0; pay-payments 19 suites / 245 pruebas ×2 y pay-vault 58 ×2, `--maxWorkers=2`; la corrida fallida previa está en `2b-pay-payments-test-0-FALLA-PREVIA.txt` con su clasificación). Pruebas nuevas: `test/ola2.tanda2b.spec.ts` (19).

1. **`payment_method_unavailable`**: no es del catálogo, así que respuesta, fila, `last_error` y evento usan el MISMO `validation_failed`; el motivo va en `detail` y en el código de campo documentado. El motivo fino se guarda aparte (`payment_intents.failure_reason`). Propuesta del código al catálogo: `PROPUESTAS.md` PROP-15 (con el parche exacto).
2. **Llamadas salientes**: todas llevan `X-Service-Id: pay-payments`; ledger y conectores llevan `X-Pay-Mode` igual al del cobro (probado en `test` y `live` con cobro, cancelación, reembolso+consulta y contracargo). Riesgo no lleva `X-Pay-Mode` porque su contrato no lo declara (PROP-16). pay-settlement: pay-payments no lo llama.
3. **`X-Pay-Mode` en TODA ruta**: prueba que recorre cada ruta del controlador público y del interno (los GET de reembolsos incluidos) y exige 403 sin modo o con modo inválido. Las disputas no tienen rutas HTTP (decisión del dueño, D-4): se prueba que no existen.
4. **Regla 11 con consultas autoritativas**: un `404` de `GET /refunds/{id}` o de `GET /charges/{id}/status` ya no anula nada. El reembolso queda `pending` con la retención puesta; se escala (`refund_not_found_at_connector` / `charge_not_found_at_connector`, con evento) y el workflow sigue vivo y se resuelve cuando el conector responde. Al vencer, un cargo que el conector dice no conocer NO vence ni se cancela: queda escalado y el workflow falla visible (decisión: no hay forma de saber si se pagó).
5. **Conector lento y refund_id**: consulta que tarda menos que el timeout (se aplica), más que el timeout (ambigua: no anula, se resuelve al recuperarse) y dos reembolsos del mismo cobro que el doble distingue por `refund_id`, resueltos de forma independiente.
6. **Arreglo de una falla intermitente propia**: el primer request de los dobles pagaba la compilación de Ajv dentro del timeout de 300 ms de riesgo; ahora `DoubleServer.start()` precalienta los validadores.
