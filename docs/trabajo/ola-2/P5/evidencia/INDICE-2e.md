# Evidencia P5 — ola 2, tanda 2e (y 2d)

| Punto | Prueba | Resultado |
|---|---|---|
| 1) `pay-risk` implementa el contrato nuevo | `pay-risk/test/contract-conformance.spec.ts` (8) | operaciones del contrato = rutas montadas; un pedido con TODOS los campos de `AssessmentCreate` (`merchant_name`, `merchant_entity_type`, `name`, `entity_type`) cumple el contrato y se acepta, con la respuesta completa de `Assessment`; **sin `required`**: solo el pagador / `screening: {}` / sin `screening` ⇒ 201 `review`/`screening_not_provided` (no 422); `merchant_name` de 1 y 300 caracteres sí, vacío / 301 / tipo ajeno / `name` de 201 / campo extra ⇒ 422 y el contrato opina igual. Corrección: el límite del servicio era 200, el contrato dice 300 |
| 2) sin sustitución de `merchant_closed` | `pay-merchants/test/merchant-close-keys.spec.ts` (7) | los `api_key.revoked` validan contra el AsyncAPI vigente sin sustituciones |
| 3) motivo del cierre | misma suite | cada clave viva se revoca con `reason: merchant_closed`, un evento por clave antes de `merchant.closed` |
| 4) `pay-schedules` | `grep` de `risk`/`screening` en `src` y `test` | sin cuerpos de riesgo: no hay nada que ajustar (ejecuta directo contra el ledger, PR-18) |
| 5) PR-18 | `PROPUESTAS.md` | sigue abierta, sin migrar |
| 2d) agrupación por intento (PROP-19) | `pay-risk/test/intent-grouping.spec.ts` (9) | el grupo es `payment_intent_id`; importe del intento = el MAYOR evaluado (la «primera» no es determinista con `created_at` iguales: falló una vez y se corrigió); estable en 3 corridas aisladas |
| 2d) D-33 `legal_name` | `pay-merchants/test/legal-name-event.spec.ts` (6), `authz.spec.ts`, `pay-schedules/test/replica.spec.ts` (+3) | solo en `merchant.created` y `merchant.activated`, misma transacción, validan sin sustituciones; ni en otros eventos, logs, errores; `pay-schedules` lo ignora y no lo guarda |

Archivos: `2e-gates-typecheck-build.txt`, `2e-gates-eslint-raiz.txt`, `2e-contracts-lint.txt`, `2e-test-2-corridas.txt` (los `2d-*` son la tanda anterior: las pruebas de conformidad que fallaron en `2d-test-2-corridas.txt` fallaron porque el contrato cambió bajo ellas, y se actualizaron en 2e).

**No cubierto:** la latencia p99 de `pay-risk` (P5.H2.M4, ENVIRONMENT bajo carga compartida, prueba de carga real = T-01 de la ola 3) sigue A MEDIAS.
