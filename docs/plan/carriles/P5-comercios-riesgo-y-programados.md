# Carril P5 — Comercios, riesgo y pagos programados

> **Estado:** `EN CURSO` (ola 0) · **AVANCE: 0 / 18 — 0,0 %** · **Peldaño:** `TESTED` en lo marcado HECHO; `UNKNOWN` en el resto
> **Predecesor:** P1.H1 (plataforma y plantilla).
> **Carpetas del monorepo:** `services/pay-merchants/`, `services/pay-risk/`, `services/pay-schedules/` · esquema en `mantra-core-health-model`.
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md)

**Skills:** `multi-tenancy`, `authn-identity`, `authz-access-control`, `consent-management`, `audit-trail-history`,
`data-privacy-phi`, `file-uploads-media`, `background-jobs-scheduling`, `state-machines-workflows`,
`quotations-billing`, `security-guardrails`, `procesos-alovida`, `evidence-and-verification`.

## Resultado observable

Una empresa se registra, pasa la diligencia debida, acepta su contrato versionado y opera con una
comisión acordada, menor si trabaja directo con la pasarela. Recibe API keys que puede rotar.
Cada cobro pasa por un control de riesgo que puede frenarlo con un motivo. El médico programa sus
pagos mensuales y los proveedores sus comisiones a ALOVIDA, y el sistema los ejecuta solo y avisa
cuando no hay fondos.

**Kill-test:** activar un comercio sin KYC aprobado o sin contrato aceptado. Si queda `active`, no
está hecho. Programar un pago mensual de 1.000,00 con 500,00 disponibles: si se ejecuta, o si se
ejecuta dos veces cuando el job corre dos veces, tampoco.

## Contratos

- **Expone:** la semántica de la API pública `merchants/me`, `api_keys` y `mandates`;
  `internal/risk/v1/assessments`; eventos `merchant.*`, `fee_schedule.published`, `api_key.*`,
  `mandate.*` y `scheduled_payment.*`.
- **Consume:** `internal/payments/v1/intents` (P3) para mandatos que cobran;
  `internal/settlement/v1/payouts` e `internal/ledger/v1/holds` (P2) para mandatos que pagan; moov
  Watchman (cribado).

## Criterios

- **REQ-P5-1** — Dado un comercio, cuando se intenta pasarlo a `active`, entonces se exige KYC `approved` **y** contrato aceptado en su versión vigente; si falta alguno, `409` con el motivo. (7.1, 7.2) — `MISSING`
- **REQ-P5-2** — Dado un contrato aceptado, cuando se consulta, entonces muestra versión, hash del texto, quién lo aceptó y cuándo; la aceptación no se edita. — `MISSING`
- **REQ-P5-3** — Dado un tarifario por canal con una tasa menor para el canal «directo», cuando se publica, entonces sale `fee_schedule.published` con versión y vigencia, y las versiones viejas quedan intactas. (7.3, 7.9) — `MISSING`
- **REQ-P5-4** — Dada una API key, cuando se crea, entonces se muestra una sola vez, se guarda solo su hash y se publica `api_key.created`; rotarla deja las dos válidas durante un periodo de gracia. — `MISSING`
- **REQ-P5-5** — Dado un pagador en una lista de sanciones o un intento que supera el límite de velocidad, cuando se evalúa, entonces la decisión es `deny` o `review` con un motivo estable. (7.6) — `MISSING`
- **REQ-P5-6** — Dado un mandato mensual, cuando llega su fecha, entonces se ejecuta una sola vez por periodo aunque el job corra dos veces; sin fondos, queda `insufficient_funds`, se reintenta según la política y se avisa. (7.7) — `MISSING`
- **REQ-P5-7** — Dado un acuerdo de comisión de un proveedor, cuando llega el corte, entonces se programa el cobro de la comisión a ALOVIDA según el acuerdo. (7.8) — `MISSING`
- **REQ-P5-8** — Dado cualquier documento de KYC, cuando se guarda, entonces queda fuera de la base (almacén de objetos con acceso autorizado), con tipo real y tamaño validados, y sin datos personales en logs. — `MISSING`

## H1 — `pay-merchants` (olas 0 y 1)

**CA:** Dada una empresa, cuando completa el alta, entonces queda activa solo con KYC y contrato, con su tarifario y sus claves.
**DoD:** REQ-P5-1 a 4 y 8 en verde contra Postgres real.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P5.H1.M1 | Esquema `pay_merchants` en el modelo (desde `connected_accounts`, `kyc_verifications` y `fee_schedules`) + **contraste con los 18 puntos del alta legal** de los módulos 3–6 (`procesos-alovida`) | Sin deriva; los 18 puntos mapeados o escalados en un issue | Verificador de deriva + tabla de mapeo | TODO |
| P5.H1.M2 | Máquina de estados del comercio (`pending → active → suspended → closed`) | REQ-P5-1 | Test pegado | TODO |
| P5.H1.M3 | KYC: documentos al almacén de objetos, revisión y nivel de riesgo | REQ-P5-8 | Test pegado | TODO |
| P5.H1.M4 | Contratos versionados y aceptación inmutable | REQ-P5-2 | Test pegado | TODO |
| P5.H1.M5 | Tarifario por canal y acuerdo, con vigencia + evento | REQ-P5-3 | Test pegado | TODO |
| P5.H1.M6 | API keys (`sk_test_` / `sk_live_`), hash SHA-256 con `@pay/api-key` (D-27), rotación con gracia, revocación + eventos | REQ-P5-4 | Test pegado | TODO |
| P5.H1.M7 | **Tarifario de alcance completo** (D-07): % + fijo por transacción, mínimo y tope, descuento por canal directo (7.9) y abono mensual; el cálculo vive en `@pay/money` y lo usan P3 y P2 | Para cada combinación, comisión + neto = bruto (test de propiedades) | Test pegado | TODO |

## H2 — `pay-risk` (olas 1 y 2)

**CA:** Dado un intento de cobro, cuando se evalúa, entonces la decisión llega en menos de 300 ms con un motivo estable.
**DoD:** REQ-P5-5 + latencia p99 medida.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P5.H2.M1 | **Spike** Watchman: cargar listas, latencia de búsqueda, licencia en su `LICENSE` | Responde sí o no con criterio | `evidencia/spike-watchman.md` | A MEDIAS |
| P5.H2.M2 | Motor de reglas versionado (monto, velocidad por comercio y pagador, horario) | REQ-P5-5 (velocidad) | Test pegado | TODO |
| P5.H2.M3 | Cribado de sanciones integrado | REQ-P5-5 (sanciones) | Test con nombres sintéticos de la lista de prueba | TODO |
| P5.H2.M4 | `POST /assessments` con p99 < 300 ms | Latencia medida | Salida de la prueba de carga | TODO |
| P5.H2.M5 | Registro auditable de cada decisión (sin datos personales en claro) | Toda decisión tiene su rastro | Consulta pegada | TODO |

## H3 — `pay-schedules` (olas 1 y 2)

**CA:** Dado un mandato, cuando llega su fecha, entonces se ejecuta una vez, con reintentos y aviso.
**DoD:** REQ-P5-6 y 7 + flujo E5.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P5.H3.M1 | Esquema `pay_schedules` (desde `payment_mandates`, `installment_plans` e `installment_schedules`) | Sin deriva | Verificador de deriva | TODO |
| P5.H3.M2 | Mandatos del médico (7.7): beneficiario, monto, calendario y tope; retención en `schedule:{id}:reserve` | REQ-P5-6 | Test pegado | TODO |
| P5.H3.M3 | Ejecutor idempotente por `(mandato, periodo)` + reintentos + evento `scheduled_payment.*` | El job corrido dos veces → una ejecución | Test pegado | TODO |
| P5.H3.M4 | Comisiones programadas de proveedores (7.8) | REQ-P5-7 | Test pegado | TODO |
| P5.H3.M5 | E5 de punta a punta (fondos insuficientes → reintento → éxito) | E5 en verde | Salida del E2E | TODO |
| P5.H3.M6 | Aviso al médico o proveedor (vía webhook o evento para el monolito) sin datos sensibles | Evento emitido con solo ids y montos | Test pegado | TODO |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| P3 intents | `internal/payments/v1/intents` | Intento creado | El mismo mandato y periodo dos veces → un intento | Comercio suspendido → `403` |
| P2 ledger y payouts | `internal/ledger/v1/holds` · `settlement/v1/payouts` | Retención y payout aceptados | Saldo exactamente igual al monto | `insufficient_funds` |
| Watchman | Su API HTTP | Sin coincidencia | Coincidencia aproximada en el umbral | Watchman caído → `review`, nunca `allow` |

## Estado de la ola 0 (A MEDIAS, con las cuatro respuestas)

**P5.H2.M1 — Spike Watchman.** *Qué anda:* con `moov/watchman:v2-static` (v0.58.1, **datos congelados de 2019**, 7.379 registros) la API responde con p99 < 30 ms en 50 búsquedas por caso ([`watchman.md`](../../spikes/watchman.md), `TESTED`). *Qué no anda:* **no se cargaron las listas vigentes** (sin acceso a treasury.gov y otras desde el entorno); una coincidencia exacta puntuó solo 0,812 y un error de una letra 0,602. *Qué falta:* cargar las listas vigentes desde un caché propio, medir bajo concurrencia, y que cumplimiento fije los umbrales (Q-12). *Dónde quedó:* Watchman `v2-static` en el Compose, solo para sandbox.

## Gates y entrega

Gates de §7 del maestro + `data-privacy-phi` (KYC = datos personales). PRs contra `dev`,
mergeables (regla 35).
