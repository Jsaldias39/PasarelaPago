# Evidencia P5 — ola 2, tanda 2b

| Punto | Prueba | Resultado |
|---|---|---|
| 1. Llamadas salientes con `X-Service-Id` y `X-Pay-Mode` | `pay-schedules/test/outbound.spec.ts` (7 operaciones × test/live, el doble valida cada petición contra `internal-ledger-v1.yaml`), `outbound-audit.spec.ts` en los tres servicios (lista exacta de archivos con HTTP saliente) | pay-schedules habla SOLO con `pay-ledger`; pay-merchants no llama a nadie; pay-risk solo a Watchman (nombre y tipo, sin modo) |
| 1. Negativa sin modo | `outbound.spec.ts` «sin modo el libro mayor responde 403» | el doble responde 403 sin aplicar nada; el pago queda `due` (no ejecutado, no `failed`), misma clave, y al volver el modo se ejecuta UNA vez; si no vuelve, `failed` `ledger_unavailable` + `needs_review`, sin void |
| 2. Consumidor `merchant.*` con NATS real | `pay-schedules/test/nats-replica.spec.ts` (NATS 54222, stream y temas propios de la prueba, eventos del AsyncAPI vigente) | 10 pruebas: orden, evento viejo tardío, repetición (inbox), 5 inválidos descartados sin bloquear, consumidor sin pendientes |
| 3. Contrato de pay-risk | `pay-risk/test/contract-conformance.spec.ts` | 4 operaciones y todos los campos (`entity_type`, `/rule_sets`); cerrado: nombre en blanco y huella vacía (válidos en el contrato) ya no se rechazan |
| 4. P5.H2.M4 | sin tocar | A MEDIAS: ENVIRONMENT (fallos solo bajo load 8–10); la prueba de carga real es T-01 de la ola 3 |

Archivos: `2b-gates-typecheck-build.txt`, `2b-gates-eslint-raiz.txt`, `2b-test-2-corridas.txt`.
