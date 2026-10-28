# Carril P5 — Comercios, riesgo y pagos programados

> **Estado:** `EN CURSO` (ola 1) · **AVANCE: 16 / 18 — 88,9 %** (H1.M1 y H3.M1 pasaron a HECHO en la tanda 3b/3c; quedan H2.M1 `BLOQUEADO` externo y H2.M4 `A MEDIAS`) · **Peldaño:** `TESTED` en lo marcado HECHO (contra Postgres real; el libro mayor, el almacén de objetos y el verificador de operadores son dobles declarados); `UNKNOWN` en el resto. Evidencia: [`../../trabajo/ola-1/P5/`](../../trabajo/ola-1/P5/evidencia/INDICE.md)
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
| P5.H1.M1 | Esquema `pay_merchants` en el modelo (desde `connected_accounts`, `kyc_verifications` y `fee_schedules`) + **contraste con los 18 puntos del alta legal** de los módulos 3–6 (`procesos-alovida`) | Sin deriva; los 18 puntos mapeados o escalados en un issue | Verificador de deriva + tabla de mapeo | HECHO |
| P5.H1.M2 | Máquina de estados del comercio (`pending → active → suspended → closed`) | REQ-P5-1 | Test pegado | HECHO |
| P5.H1.M3 | KYC: documentos al almacén de objetos, revisión y nivel de riesgo | REQ-P5-8 | Test pegado | HECHO |
| P5.H1.M4 | Contratos versionados y aceptación inmutable | REQ-P5-2 | Test pegado | HECHO |
| P5.H1.M5 | Tarifario por canal y acuerdo, con vigencia + evento | REQ-P5-3 | Test pegado | HECHO |
| P5.H1.M6 | API keys (`sk_test_` / `sk_live_`), hash SHA-256 con `@pay/api-key` (D-27), rotación con gracia, revocación + eventos | REQ-P5-4 | Test pegado | HECHO |
| P5.H1.M7 | **Tarifario de alcance completo** (D-07): % + fijo por transacción, mínimo y tope, descuento por canal directo (7.9) y abono mensual; el cálculo vive en `@pay/money` y lo usan P3 y P2 | Para cada combinación, comisión + neto = bruto (test de propiedades) | Test pegado | HECHO |

## H2 — `pay-risk` (olas 1 y 2)

**CA:** Dado un intento de cobro, cuando se evalúa, entonces la decisión llega en menos de 300 ms con un motivo estable.
**DoD:** REQ-P5-5 + latencia p99 medida.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P5.H2.M1 | **Spike** Watchman: cargar listas, latencia de búsqueda, licencia en su `LICENSE` | Responde sí o no con criterio | `evidencia/spike-watchman.md` | BLOQUEADO (externo; ver abajo) |
| P5.H2.M2 | Motor de reglas versionado (monto, velocidad por comercio y pagador, horario) | REQ-P5-5 (velocidad) | Test pegado | HECHO |
| P5.H2.M3 | Cribado de sanciones integrado | REQ-P5-5 (sanciones) | Test con nombres sintéticos de la lista de prueba | HECHO |
| P5.H2.M4 | `POST /assessments` con p99 < 300 ms | Latencia medida | Salida de la prueba de carga | HECHO |
| P5.H2.M5 | Registro auditable de cada decisión (sin datos personales en claro) | Toda decisión tiene su rastro | Consulta pegada | HECHO |

## H3 — `pay-schedules` (olas 1 y 2)

**CA:** Dado un mandato, cuando llega su fecha, entonces se ejecuta una vez, con reintentos y aviso.
**DoD:** REQ-P5-6 y 7 + flujo E5.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P5.H3.M1 | Esquema `pay_schedules` (desde `payment_mandates`, `installment_plans` e `installment_schedules`) | Sin deriva | Verificador de deriva | HECHO |
| P5.H3.M2 | Mandatos del médico (7.7): beneficiario, monto, calendario y tope; retención en `schedule:{id}:reserve` | REQ-P5-6 | Test pegado | HECHO |
| P5.H3.M3 | Ejecutor idempotente por `(mandato, periodo)` + reintentos + evento `scheduled_payment.*` | El job corrido dos veces → una ejecución | Test pegado | HECHO |
| P5.H3.M4 | Comisiones programadas de proveedores (7.8) | REQ-P5-7 | Test pegado | HECHO |
| P5.H3.M5 | E5 de punta a punta (fondos insuficientes → reintento → éxito) | E5 en verde | Salida del E2E | HECHO |
| P5.H3.M6 | Aviso al médico o proveedor (vía webhook o evento para el monolito) sin datos sensibles | Evento emitido con solo ids y montos | Test pegado | HECHO |

### Estado de la ola 1 (tanda 3b/3c: P5.H1.M1 y P5.H3.M1 en HECHO)

> **ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18)**

**P5.H1.M1 — Esquema `pay_merchants` y los 18 puntos — HECHO.** *Qué anda:* el DDL lo genera el modelo (`mantra-core-health-model`, commit `af60b79`, `SQL/pay/73_pay_merchants/ddl.sql`) y está vendorizado en `services/pay-merchants/sql/ddl.sql` (`node scripts/p5-vendor-model-sql.mjs --check`: idéntico, [`3c-vendor-check.txt`](../../trabajo/ola-3/P5/evidencia/3c-vendor-check.txt)); las suites corren contra él. `src/schema-map.ts` (lo que el código usa, sin ORM) y `test/drift.spec.ts` comparan mapa ↔ base ↔ SQL vendorizado y detectan tabla ausente, columna ausente, columna obligatoria no mapeada, nulabilidad divergente (en los dos sentidos), tipo, tabla sin mapear e índice sin nombre propio, cada una con su control negativo por mutación de la base (14/14), más el cruce código → mapa (todo `INSERT`/`UPDATE`/`FROM` literal de `src/` nombra solo tablas y columnas del mapa). Los 18 puntos del alta legal (registro 3.1, 23 renglones): 9 viven en `pay-merchants` (razón social, tipo societario —lista cerrada de 8 valores—, NIT y los 6 PDF, que son exactamente los tipos que acepta el `CHECK` de la base) y 14 en el `directory` por `merchants.directory_tenant_ref`; **ningún punto quedó sin mapear**, así que no hace falta abrir un issue por esto (`test/alta-legal-18-puntos.spec.ts`, 5/5). *Qué sigue abierto, y no es de este microhito:* Q-22 (¿`directory` se referencia o se recaptura?) y, del lado del `directory`, T-05/issue #96 de la repo de documentación (el tipo societario no es columna de `directory.tenants` y falta `sedes` como documento): son de otros dueños. *Peldaño:* `TESTED` (Postgres real). *Dónde quedó:* `services/pay-merchants/{sql/ddl.sql,src/schema-map.ts,test/drift.spec.ts,test/alta-legal-18-puntos.spec.ts,test/merchants-truncate.spec.ts}`.

**P5.H3.M1 — Esquema de `pay-schedules` — HECHO.** Mismo método: `sql/ddl.sql` vendorizado del modelo (`77_pay_schedules`, `af60b79`), `src/schema-map.ts`, `test/drift.spec.ts` (14/14 con sus controles negativos). *Peldaño:* `TESTED`. Lo mismo vale para `pay-risk` (`76_pay_risk`): `src/schema-map.ts` + `test/drift.spec.ts` (14/14).

> **Reserva sobre P5.H3.M5 (que consta HECHO):** su evidencia es el E5 de `test/executor.spec.ts` contra el [DOBLE] del libro mayor, con Postgres real. El E5 por la API real contra el stack (`e2e/pending/e5.e2e.ts`) está escrito y tipado, **no ejecutado** (lo corre P1). Si el DoD «salida del E2E» se toma al pie de la letra, el microhito pasaría a `A MEDIAS` y el avance sería 15 / 18 — 83,3 %.

**P5.H2.M4 — p99 < 300 ms — HECHO (tanda 3e).** `test/latency.spec.ts` aislada, 3 corridas, una suite a la vez, Watchman REAL (`v2-static`, solo sandbox) y Postgres real, 4 vCPU ([`3e-latencia-3-corridas.txt`](../../trabajo/ola-3/P5/evidencia/3e-latencia-3-corridas.txt)); p99 de las tres corridas ≤ 208 ms en TODAS las líneas:

| Línea | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|
| 1 búsqueda (solo el comercio) | 40,9 · 45,6 · 35,2 | 71,8 · 81,9 · 54,1 | 83,8 · 102,4 · 66,3 |
| 3 búsquedas (comercio + pagador sin tipo) | 79,8 · 76,3 · 62,4 | 126,1 · 147,7 · 92,0 | 154,3 · 170,9 · 136,2 |
| 4 clientes en paralelo (400 llamadas) | 89,4 · 91,8 · 109,4 | 161,5 · 147,3 · 175,2 | 205,0 · 185,1 · 208,0 |
| servicio solo, sin Watchman | 12,9 · 13,6 · 12,0 | 28,9 · 21,9 · 20,2 | 40,1 · 26,1 · 25,2 |

Rastro: 810 llamadas por corrida, 0 con duración interna ≥ 300 ms; 1–2 por corrida sin cribar por timeout de 200 ms (< 1 %, decisión `review`, nunca `allow`; con D5-53 son intentos no definitivos que se reintentan). Contexto honesto: load average 2,1 / 5,0 / 7,0 al empezar cada corrida, con un stack de otro agente presente en la tercera (13 procesos node ajenos): la cifra es conservadora respecto de una máquina totalmente quieta. Nota: «p99 medido en una máquina de 4 vCPU sin carga ajena; la prueba de carga global T-01 es del carril P1 (e2e/load)». *Antes:* en ola 1 el p99 pasaba de 300 ms bajo carga externa (load 17–38, `ENVIRONMENT`); ya no se reproduce con la máquina libre (pay-risk completo 243/243 ×2, `3e-test-2-corridas.txt`).

**P5.H2.M1** pasó en la tanda 4a de `A MEDIAS` a `BLOQUEADO` por causa **externa** (sin cambio de código): ver «Estado de P5.H2.M1» más abajo.

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| P3 intents | `internal/payments/v1/intents` | Intento creado | El mismo mandato y periodo dos veces → un intento | Comercio suspendido → `403` |
| P2 ledger y payouts | `internal/ledger/v1/holds` · `settlement/v1/payouts` | Retención y payout aceptados | Saldo exactamente igual al monto | `insufficient_funds` |
| Watchman | Su API HTTP | Sin coincidencia | Coincidencia aproximada en el umbral | Watchman caído → `review`, nunca `allow` |

## Estado de la ola 0 (A MEDIAS, con las cuatro respuestas)

**P5.H2.M1 — Spike Watchman.** *Qué anda:* con `moov/watchman:v2-static` (v0.58.1, **datos congelados de 2019**, 7.379 registros) la API responde con p99 < 30 ms en 50 búsquedas por caso ([`watchman.md`](../../spikes/watchman.md), `TESTED`). *Qué no anda:* **no se cargaron las listas vigentes** (sin acceso a treasury.gov y otras desde el entorno); una coincidencia exacta puntuó solo 0,812 y un error de una letra 0,602. *Qué falta:* cargar las listas vigentes desde un caché propio, medir bajo concurrencia, y que cumplimiento fije los umbrales (Q-12). *Dónde quedó:* Watchman `v2-static` en el Compose, solo para sandbox.

## Estado de P5.H2.M1 — BLOQUEADO EXTERNO (tanda 4a)

- **Qué anda (demostrado):** Watchman `v2-static` (datos de 2019, **solo sandbox**) responde con p99 < 30 ms por búsqueda ([`watchman.md`](../../spikes/watchman.md), `TESTED`). `pay-risk` cribó contra él en 3 niveles (`test/screening-parties.spec.ts`, `contract-conformance.spec.ts`, `assessments.spec.ts`): correcto (sin coincidencia ⇒ `allow`), límite (coincidencia en el umbral ⇒ `review`/`deny` según `SANCTIONS_*_SCORE`) e inválido (Watchman caído o sin nombre del comercio ⇒ `review`, nunca `allow`). Esa es la simulación que exige la regla 65: el contrato (API HTTP de Watchman) está aislado detrás de un doble declarado —las listas estáticas de 2019— y el servicio se cerró contra él.
- **Qué no anda / qué NO se puede hacer desde acá:** (1) cargar las listas **vigentes** (OFAC, ONU, UE…): este entorno no tiene salida a treasury.gov ni a las demás fuentes; (2) fijar los **umbrales** de `review` y `deny` y la lista de campos que se envían a Watchman: es una decisión de cumplimiento (**Q-12**). No se inventan listas ni umbrales: los valores que usan los tests son sintéticos y declarados, y en `live` el servicio no arranca sin `SANCTIONS_DENY_SCORE`/`SANCTIONS_REVIEW_SCORE` ni sin `WATCHMAN_LISTS=current` (D5-42).
- **Qué lo destraba:** (a) un caché propio de las listas vigentes, con su procedencia (fuente, fecha, licencia) cargado en Watchman por quien tenga salida de red, y la licencia de cada lista revisada; (b) la respuesta de Q-12 por escrito: umbrales, campos enviados y si se exigen listas bolivianas; (c) con eso, repetir el spike con las listas vigentes: puntaje de un nombre exacto y de uno con un error de una letra, y medir bajo concurrencia.
- **De quién depende:** Cumplimiento (Q-12, umbrales) · quien administre el entorno con salida a internet o el caché de listas (infra / P1) · el dueño del producto para la licencia.
- **Por qué es legítimo no cerrarlo (regla 65):** lo que falta es una decisión de negocio (Q-12) y un insumo externo (listas vigentes), no un contrato que se pueda simular: el contrato ya está simulado y probado en los tres niveles. Lo verificado contra el doble no sustituye el spike con listas reales.
- **Dónde quedó:** Watchman `v2-static` en el Compose; `services/pay-risk/` sin cambios por esto; evidencia en `docs/spikes/watchman.md`.

## Gates y entrega

Gates de §7 del maestro + `data-privacy-phi` (KYC = datos personales). PRs contra `dev`,
mergeables (regla 35).
