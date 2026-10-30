> **AVANCE INT: 0 / 5 — 0,0 %.** `INT.H1.M2` e `INT.H1.M3` están `A MEDIAS` (escritas y probadas contra dobles; el cliente y el verificador de firma, además, contra el sandbox REAL de la pasarela). `M1`, `M4` y `M5` están `BLOQUEADO` por algo externo.

# Informe INT — la API cobra por la pasarela (M2 + M3)

- Repo de la API: `mdavila-2001/mantra-core-health-api`, rama `claude/adoring-allen-ly7r6f`, HEAD `aa38ddbe` (subida; **sin PR**, por decisión del usuario).
- Peldaño de evidencia: `TESTED` en la API (dobles y almacén en memoria); `VERIFIED` solo para el cliente HTTP y la verificación de firma contra el stack sandbox real (abajo). No hay `REGRESSION_VERIFIED`.
- Implementó un agente distinto del integrador; el integrador repitió los gates.

## Verificación del integrador (salidas en `evidencia/`)

| Qué | Resultado |
|---|---|
| `tsc --noEmit` (heap 8 GB) en la API | exit 0 |
| `eslint` sobre `src/modules/payments`, `main.ts`, `app.module.ts` | exit 0 |
| `jest src/modules/payments --runInBand` | 17 suites / 361 tests en verde ([salida](./evidencia/api-payments-tests.txt)) |
| Cliente + verificador de la API contra el stack sandbox real de 12 servicios ([corrida](./evidencia/sandbox-real-corrida.txt), [script](./evidencia/run-client.ts.txt)) | crear → 201 `requires_action` (fee 425 de 15 000); repetir con la misma clave → `replayed:true`, mismo `pi_…`; el cobro llega a `succeeded`; 8 entregas de webhook, todas verifican con el verificador de la API; una entrega con un byte alterado → `no_matching_signature` |

## Qué hace (flag `PAYMENTS_VIA_GATEWAY`, apagado por defecto)

- El cobro se despacha en `POST /payments/intents/:id/transactions`, **no** al crear la intención (la compuerta de riesgo del camino viejo vive en `processTransaction`; despachar al crear la salteaba por construcción). `createIntent` solo valida que la pasarela pueda cobrarla.
- `Idempotency-Key` determinista `mantra-pi-v1-<sha256(tenant, deuda u orden, clave local)>`; timeout/5xx/409-en-curso se reintentan con la MISMA clave (regla 11); si se agotan: `504 PAYMENT_GATEWAY_RESULT_AMBIGUOUS` y la intención queda pendiente, sin anular nada.
- Mismas compuertas que el camino viejo (estado, operación abierta, riesgo, saldo), más: solo `SALE` por el importe completo; `PI_PROCESSING` sin cobro en la pasarela → 409; con `gatewayIntentRef` → consulta (no crea otro cobro). Con el flag apagado, el camino viejo no cambia (160 tests previos en verde sin tocar ningún spec).
- Receptor `POST /payments/gateway-webhooks`: Standard Webhooks (HMAC `v1`, Ed25519 `v1a`) sobre los bytes crudos, ventana anti-replay de 300 s, bandeja en `payment_webhook_events` (`gateway_event_ref = pay-gateway:<webhook-id>`, índice único, `FOR UPDATE` de la intención), 2xx solo tras `COMMIT`; paridad de firma con 15 vectores generados por `@pay/webhook-signature`.
- Hallazgos de la revisión de seguridad automática (3): reales, resueltos y cubiertos por tests con mutaciones (cada compuerta quitada a propósito hace fallar tests).

## Hallazgo para la pasarela

`pay-edge` rechazó con `422 card_number_detected` un `metadata` que llevaba un UUID: el guardia de PAN lo leyó como tarjeta. Es el falso positivo **DT-19** (ver `docs/trabajo/ola-1/P1/DECISIONES-TOMADAS.md`) observado con un cliente real: un UUID es un identificador legítimo y común. El cliente de la API lo evita no enviando `metadata`; la causa sigue abierta en la pasarela (P1/P3).

## Qué NO cubre

- Persistencia real de la bandeja (índice único, `FOR UPDATE`, concurrencia entre webhooks duplicados): los repositorios se probaron con fakes. La suite de integración de la API exige `AppModule` completo con PostgreSQL, MongoDB, Redis, OpenSearch y el esquema del repo del modelo; esas imágenes no están disponibles aquí (Docker Hub 429).
- La API arrancada de punta a punta (UI → solicitud → respuesta → persistencia → recarga).
- `openapi/openapi.yaml`, `openapi/ENDPOINTS.md` e inventario generado: hay ruta nueva y campos nuevos sin reflejar (requieren infraestructura levantada).
- Autorización negativa del endpoint público más allá de la firma; refunds por la pasarela; modo `wallet`; varias deudas por intención; la factura de `billing`.
- Suite completa de la API tras el último commit (la corrida previa tuvo un único rojo, `xlsx-parser.spec.ts`, clase `ENVIRONMENT`: `cdn.sheetjs.com` bloqueado por el proxy).

## Ambigüedades y decisiones (supuesto → a quién confirmar)

1. Dónde se despacha el cobro (movido a `processTransaction`; el carril decía «al crear un cobro») → P3 / dueño de M42.
2. Riesgo `REVIEW`: el camino viejo lo deja pasar; con la pasarela se bloquea (conservador) → dueño de M42.
3. `expired` → `PI_FAILED` (no existe `PI_EXPIRED`) → dueño de M42.
4. Tras `failed`/`canceled`/`expired` la deuda vuelve a `DEBT_PENDING` y el checkout se cierra como expirado → P3 / producto.
5. La factura de `billing` no se actualiza desde payments → dueño de billing.
6. Con el flag apagado el receptor responde 503 (no 410, que haría que la pasarela deshabilite el endpoint): los cobros en vuelo no se aplican hasta reencender → P1 / P3.
7. Se reutiliza el `gatewayId` de la intención porque `payment_webhook_events.gateway_id` es obligatorio; una fila propia exige seed y cambio en el repo del modelo → dueño del modelo / P3.
8. Falta el índice `ix_payment_intents_gateway_intent_ref` (propuesta para `mantra-core-health-model`; no se hizo).
9. Nada impide configurar una `sk_live_` con el flag encendido → P1.
10. Un cobro ambiguo se retoma solo si el cliente repite la operación; no hay job de reconciliación → decidir quién lo hace y cuándo se escala a una persona.
