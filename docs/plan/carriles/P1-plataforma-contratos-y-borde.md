# Carril P1 — Plataforma, contratos y borde

> **Estado:** `EN CURSO` (ola 0) · **AVANCE: 5 / 26 — 19,2 %** · **Peldaño:** `TESTED` en lo marcado HECHO; `UNKNOWN` en el resto
> **Predecesor:** ninguno. **Este carril es el predecesor de la ola 0 de todos los demás**: sin `pay-platform` sano y la plantilla publicada, nadie arranca.
> **Carpetas del monorepo:** `contracts/`, `platform/`, `services/pay-edge/`, `services/pay-webhooks/` · cumplimiento en `docs/cumplimiento/`.
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md) · Investigación: [`../INVESTIGACION.md`](../INVESTIGACION.md)

**Skills:** `api-openapi-docs`, `async-messaging-events`, `error-handling-contract`, `docker-local-stack`,
`ci-cd-pipeline`, `nestjs-development`, `authn-identity`, `authz-access-control`, `notifications-delivery`,
`backend-observability`, `environment-secrets-config`, `security-guardrails`, `evidence-and-verification`.

## Resultado observable

Un comercio llama a la API pública con su API key y una `Idempotency-Key`. La petición llega al
servicio dueño sin que el borde tenga lógica de negocio, y el comercio recibe los eventos de sus
pagos como webhooks firmados con Standard Webhooks, con reintentos que sobreviven a que su
servidor esté caído. Los otros cuatro programadores levantan todo el sistema en local con un solo
comando y crean un servicio nuevo desde la plantilla en minutos.

**Kill-test:** con la clave del comercio A, pedir `GET /v1/payment_intents/{id}` de un intento del
comercio B. Si responde algo distinto de `404`, no está hecho. Y apagar el receptor del webhook
durante 10 minutos: si al volver no recibe **todos** los eventos, cada uno con su `webhook-id`
original, tampoco.

## Contratos

- **Expone:** la forma de la API pública `v1` (OpenAPI 3.1), el catálogo de errores RFC 9457, el
  sobre CloudEvents y las librerías `@pay/*`.
- **Consume:** eventos `api_key.*` y `merchant.*` (P5) para la réplica de claves; todos los
  eventos públicos para `pay-webhooks`.

## Criterios

- **REQ-P1-1** — Dado el repo recién clonado, cuando se corre `docker compose up -d`, entonces Postgres, NATS JetStream, Temporal, TigerBeetle, Svix, OpenBao, Watchman y Jaeger reportan sano en menos de 3 minutos. — `MISSING`
- **REQ-P1-2** — Dada una petición POST sin `Idempotency-Key`, cuando llega a `pay-edge`, entonces responde `400` con `code=idempotency_key_required` en formato RFC 9457. — `MISSING`
- **REQ-P1-3** — Dada una API key revocada (evento `api_key.revoked`), cuando se usa, entonces `pay-edge` responde `401` en menos de 5 s después de publicado el evento. — `MISSING`
- **REQ-P1-4** — Dado un recurso de otro comercio, cuando se pide con la clave propia, entonces la respuesta es `404` (sin filtrar que existe). — `MISSING`
- **REQ-P1-5** — Dado un evento `payment_intent.succeeded`, cuando el endpoint del comercio responde `500` tres veces y después `200`, entonces recibe el evento exactamente con el mismo `webhook-id` y una firma `v1` que verifica con su `whsec_`. — `MISSING`
- **REQ-P1-6** — Dado un endpoint que responde `410`, cuando se le intenta entregar, entonces queda deshabilitado y no se reintenta. — `MISSING`
- **REQ-P1-7** — Dado cualquier servicio creado desde la plantilla, cuando corre su CI, entonces falla si lee una base que no es la suya. — `MISSING`

## H1 — Suelo y contratos (ola 0)

**CA:** Dado un programador nuevo, cuando clona el repo, entonces levanta el stack y genera el SDK sin pasos manuales.
**DoD:** salida de `docker compose ps` sana + `yarn build` del SDK + contratos con la etiqueta `v1-frozen`.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P1.H1.M1 | Compose local con las 8 dependencias y sus *healthchecks* | Todas en `healthy` | `docker compose ps --format json \| jq '.[].Health'` → todo `healthy` | A MEDIAS |
| P1.H1.M2 | Plantilla de servicio NestJS 11 + MikroORM 7 + pino + OTel + `/health` + outbox e inbox | Un servicio *hello* generado arranca y responde | `curl -s localhost:PORT/health` → `{"status":"ok"}` → [evidencia](../../trabajo/ola-0/evidencia/P1.H1.M2-plantilla.txt) | HECHO |
| P1.H1.M3 | Librería `@pay/money`, reciclando `payment-money.ts` y su spec de la API | Los specs reciclados pasan sin cambios de aserción | `yarn workspace @pay/money test` en verde → [evidencia](../../trabajo/ola-0/evidencia/P1.H1.M3-money.txt) | HECHO |
| P1.H1.M4 | `@pay/problem` (RFC 9457) + catálogo de `code` | Esquema validado por ajv | `yarn workspace @pay/problem test` → [evidencia](../../trabajo/ola-0/evidencia/P1.H1.M4-problem.txt) | HECHO |
| P1.H1.M5 | `@pay/idempotency`: reclamo con `INSERT` único, fases atómicas, respuesta guardada, horizonte de 24 h | 50 peticiones concurrentes con la misma clave → 1 sola ejecución | Test de integración contra Postgres real en verde → [evidencia](../../trabajo/ola-0/evidencia/P1.H1.M5-idempotency.txt) | HECHO |
| P1.H1.M6 | `@pay/webhook-signature`: Standard Webhooks `v1` y `v1a`, comparación en tiempo constante | Los vectores de prueba de la especificación verifican | `yarn workspace @pay/webhook-signature test` → [evidencia](../../trabajo/ola-0/evidencia/P1.H1.M6-webhook-signature.txt) | HECHO |
| P1.H1.M7 | Sobre CloudEvents + plantilla AsyncAPI 3 + CI de `pay-contracts` (lint de OpenAPI y AsyncAPI, detección de cambios que rompen) | Un PR que borra un campo requerido falla en CI | CI rojo sobre una rama de prueba, con la salida pegada | A MEDIAS |
| P1.H1.M8 | CI reutilizable: typecheck, lint, test, imagen y la prueba de separación de bases (REQ-P1-7) | El servicio *hello* falla al intentar leer `pay_ledger` | Log del job pegado | A MEDIAS |
| P1.H1.M9 | Adaptador que expone la transacción de MikroORM como `Queryable`, para escribir una entidad y encolar su evento en **la misma** transacción | Un evento encolado dentro de `em.transactional` no existe si la transacción se deshace | Test de integración con MikroORM y Postgres reales | TODO |

## H2 — `pay-edge` (olas 1 y 2)

**CA:** Dado un comercio activo, cuando llama a la API pública, entonces es autenticado, limitado y enrutado sin lógica de negocio en el borde.
**DoD:** REQ-P1-2, 3 y 4 con tests de integración en verde + matriz de autorización negativa.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P1.H2.M1 | Réplica de API keys hasheadas (argon2id) desde los eventos `api_key.*`, con inbox | Clave creada → usable; revocada → `401` | Test de integración con NATS JetStream real | TODO |
| P1.H2.M2 | *Rate limit* por clave y por IP (Redis), con `429` y `Retry-After` | El pedido 101 en la ventana devuelve `429` | Test de carga corto pegado | TODO |
| P1.H2.M3 | Enrutamiento a los servicios con mTLS y propagación de `traceparent` y `request_id` | La traza en Jaeger cruza borde → servicio | Captura de la traza en `evidencia/` | TODO |
| P1.H2.M4 | Matriz de autorización negativa (otro comercio, sin clave, clave revocada, entorno *test* contra *live*) | Todos los casos dan `401`/`404` | Suite `authz.e2e` en verde | TODO |

## H3 — `pay-webhooks` sobre Svix (olas 1 y 2)

**CA:** Dado un evento público, cuando el comercio tiene un endpoint suscrito, entonces lo recibe firmado, con reintentos, y lo puede verificar.
**DoD:** REQ-P1-5 y 6 + flujo E6 en verde.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P1.H3.M1 | Consumidor de eventos públicos → `svix.message.create` con `eventId` = id del CloudEvent | Republicar el mismo evento no duplica la entrega | Test de integración contra Svix real | TODO |
| P1.H3.M2 | API `webhook_endpoints` (alta, rotación de secreto con dos firmas en paralelo, baja) | Durante la rotación verifican la firma vieja y la nueva | Test pegado | TODO |
| P1.H3.M3 | Receptor de prueba que verifica la firma (para E6 y como ejemplo para comercios) | Una firma alterada se rechaza | Test pegado | TODO |
| P1.H3.M4 | E6: endpoint caído 10 min, `500` y después `200`; `410` lo deshabilita | Todos los eventos llegan una vez cada uno | Salida del E2E + log del receptor | TODO |
| P1.H3.M5 | Política de payload: sin datos personales, solo ids y montos | grep de documento, nombre o teléfono en los payloads → 0 | Salida del grep pegada | TODO |

## H4 — Cumplimiento: PCI DSS y regulación (olas 0 a 3)

**CA:** Dado el objetivo de certificar PCI DSS v4.0.1 y operar en modo A en Bolivia, cuando un auditor o el abogado pregunta qué está en alcance y por qué, entonces la respuesta está escrita, con evidencia.
**DoD:** documentos en `docs/cumplimiento/` + prueba de segmentación pegada.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P1.H4.M1 | Mapa de alcance PCI: qué servicios tocan datos de tarjeta (CDE), cuáles están conectados y cuáles fuera de alcance, requisito por requisito de v4.0.1 | Cada servicio con su clasificación y la razón | `docs/cumplimiento/pci-alcance.md` revisado por P3 (dueño de `pay-vault`) | TODO |
| P1.H4.M2 | Cuestionario para la asesoría legal: encuadre del modo A en el reglamento del BCB (RD 079/2022 y RD 069/2021), rol de la ASFI, cuenta recaudadora, custodia de fondos de terceros, facturación de la comisión | Cada pregunta con su fuente y el supuesto que hoy toma el software | `docs/cumplimiento/preguntas-legales.md` | TODO |
| P1.H4.M3 | Segmentación de red en Coolify: `pay-vault` en una red aislada, solo alcanzable por `pay-payments` | Desde `pay-edge`, una conexión a `pay-vault` falla; desde `pay-payments`, funciona | Salida de las dos pruebas pegada | TODO |

## H5 — Sandbox de punta a punta (ola 4, D-26)

**CA:** Dado el repo recién clonado y sin ninguna credencial externa, cuando se corre un comando, entonces todo el sistema corre en modo sandbox y los flujos E1–E8 pasan.
**DoD:** `yarn e2e` con 8/8 PASS y la salida pegada.

| ID | Microtarea | CA (binario) | DoD (comando de verificación) | Estado |
|---|---|---|---|---|
| P1.H5.M1 | `platform/compose.mock.yml`: suma todos los servicios y `pay-mockbank`, con `PAY_MODE=sandbox` | Todo `healthy` con un solo comando | `docker compose -f platform/compose.yml -f platform/compose.mock.yml up -d --wait` → todo `healthy` | TODO |
| P1.H5.M2 | Semillas sintéticas **declaradas como tales** (comercios, claves `sk_test_`, tarifas, usuarios con billetera, mandatos) | La segunda corrida no inserta nada | `yarn seed:sandbox` dos veces → 0 inserciones la segunda | TODO |
| P1.H5.M3 | Suite E2E `e2e/` con E1–E8 y vigilancia de errores de los servicios | 8/8 PASS y ningún 5xx inesperado | `yarn e2e` → 8 passed | TODO |
| P1.H5.M4 | Prueba de paridad mock/real: los mismos tests de contrato corren contra `pay-mockbank` y, cuando haya credenciales, contra el conector real | Misma suite, mismos resultados esperados | `yarn test:parity` → verde contra el mock; contra el real queda declarado `BLOQUEADO` hasta tener acceso (Q-01, Q-11) | TODO |
| P1.H5.M5 | Runbook «de sandbox a producción»: lista exacta de variables y credenciales que cambian, y guardia de modo | Con `PAY_MODE=live` y el conector `mock` configurado, el sistema NO arranca | Arranque con esa combinación → falla con mensaje claro (salida pegada) | TODO |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| P5 `api_key.*` | AsyncAPI `api_key.created/revoked` | Clave creada y usable | Revocación que llega antes que la creación (reordenada) | Evento con firma de esquema inválida → a DLQ, sin crashear |
| P3 `payment_intent.*` | AsyncAPI | Evento `succeeded` | El mismo evento 3 veces | Evento de un comercio inexistente → descartado con métrica |
| Servicios internos detrás del borde | OpenAPI interna | `200` | Respuesta lenta en el borde del *timeout* | `503` → el borde devuelve `502` RFC 9457 sin filtrar detalle |

Lo verificado contra dobles se declara así en el reporte. La integración real es la ola 2.

## Estado de la ola 0 (A MEDIAS, con las cuatro respuestas)

**P1.H1.M1 — Compose local.** *Qué anda:* Postgres con un rol y una base por servicio, NATS JetStream, Redis, Temporal (con su base), Jaeger y Watchman (sandbox) llegan a `healthy` con `docker compose up -d` (evidencia: [`compose.txt`](../../trabajo/ola-0/evidencia/P1.H1.M1-compose.txt)). *Qué no anda / no se verificó:* TigerBeetle, Svix y OpenBao están en el perfil `full` y **no se ejecutaron**: sus imágenes no se pudieron bajar en el entorno de trabajo. *Qué falta:* correr `--profile full` con acceso al registro y confirmar los tres *healthchecks*. *Dónde quedó:* `platform/compose.yml`, valida con `docker compose config`.

**P1.H1.M7 — Contratos y CI de contratos.** *Qué anda:* el sobre CloudEvents con su JSON Schema y 333 mutaciones rechazadas; `yarn contracts:lint` valida 7 OpenAPI y 4 AsyncAPI ([`contratos.txt`](../../trabajo/ola-0/evidencia/P1.H1.M7-contratos.txt)). *Qué no anda:* **no existe la detección de cambios que rompen** (que un PR que borra un campo requerido falle). *Qué falta:* integrar `oasdiff` (u otra herramienta) contra la rama base y probarlo con un PR de prueba. *Dónde quedó:* `contracts/scripts/lint-contracts.mjs`.

**P1.H1.M8 — CI reutilizable.** *Qué anda:* la prueba de separación de bases (99/99 comprobaciones, [`separacion.txt`](../../trabajo/ola-0/evidencia/P1.H1.M8-separacion.txt)) y `.github/workflows/ci.yml`. *Qué no anda:* el workflow **nunca se ejecutó en GitHub** (no hay forma de correrlo desde acá). *Qué falta:* un PR de prueba que lo dispare y su salida. *Dónde quedó:* `.github/workflows/ci.yml`.

## Gates y entrega

Gates de §7 del plan maestro. PR contra `dev`, mergeable y demostrado con `gh pr view` y
`gh pr checks` (regla 35). `REPORTE.md` del carril con el avance en la primera línea (regla 40).
