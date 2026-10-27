# Reporte — Ola 0 (contratos y suelo) de la pasarela de pagos ALOVIDA

> **AVANCE: 8 / 107 — 7,5 %.** La ola 0 **NO está cerrada**: los contratos son borradores (`v1-draft`) y no están congelados.

- Fecha: 2026-10-27 · Plan: [`PLAN-MAESTRO.md`](../../plan/PLAN-MAESTRO.md) · Rama: `claude/adoring-allen-ly7r6f` (repo `Jsaldias39/PasarelaPago`)
- Peldaño de evidencia: **`TESTED`** para lo marcado `HECHO`; **`UNKNOWN`** para el resto. No se alcanzó `VERIFIED` en nada: no hay servicios de producto todavía.
- Cómo se produjo la evidencia: [`platform/scripts/collect-evidence.sh`](../../../platform/scripts/collect-evidence.sh) (repetible con el stack local arriba). Cada archivo de [`evidencia/`](./evidencia/) lleva el comando y la salida literal.

## Qué dice el criterio de salida de la ola 0 y dónde estamos

| Criterio de salida (PLAN-MAESTRO §5.1) | Estado |
|---|---|
| Contratos con la etiqueta `v1-frozen` | **No cumplido.** Hay 11 contratos válidos (7 OpenAPI, 4 AsyncAPI) pero son borradores redactados sin sus dueños: congelarlos exige que cada dueño y cada consumidor los revisen, y P1–P5 todavía no tienen nombre (Q-10). |
| `docker compose up` sano | **Parcial.** Siete servicios `healthy`; TigerBeetle, Svix y OpenBao (perfil `full`) no se pudieron ejecutar. |
| El servicio *hello* pasa CI | **Parcial.** Pasa tipos, build, 6 pruebas de arranque y proceso real; el workflow de CI está escrito pero **nunca corrió en GitHub**. |

## Completado

| ID | Qué se logró | Comando de verificación | Resultado |
|---|---|---|---|
| P1.H1.M2 | Plantilla de servicio NestJS 11 + MikroORM 7 + pino + Terminus + RFC 9457 + relé del outbox + Dockerfile, y generador. Un servicio generado compila, pasa 6 pruebas de arranque contra Postgres real y responde `/health/live`, `/health/ready` y un 404 en RFC 9457 como proceso real. | `platform/scripts/verify-template.sh` | PASS · [evidencia](./evidencia/P1.H1.M2-plantilla.txt) |
| P1.H1.M3 | `@pay/money`: código y specs de la API reciclados **sin cambiar ninguna aserción** + `splitFee` (D-07, D-20) con prueba de propiedad de 20.000 casos. | `yarn workspace @pay/money test` | 60 pruebas PASS · [evidencia](./evidencia/P1.H1.M3-money.txt) |
| P1.H1.M4 | `@pay/problem`: errores RFC 9457, catálogo de 16 códigos y JSON Schema. | `yarn workspace @pay/problem test` | 22 PASS · [evidencia](./evidencia/P1.H1.M4-problem.txt) |
| P1.H1.M5 | `@pay/idempotency`: 50 peticiones concurrentes con la misma clave → **una** ejecución, contra Postgres real; recuperación desde el último punto; toma de bloqueos vencidos. | `yarn workspace @pay/idempotency test` | 11 PASS, y 6 corridas repetidas sin intermitencia · [evidencia](./evidencia/P1.H1.M5-idempotency.txt) |
| P1.H1.M6 | `@pay/webhook-signature`: Standard Webhooks `v1` (idéntico byte a byte a la librería de referencia) y `v1a`. | `yarn workspace @pay/webhook-signature test` | 17 PASS · [evidencia](./evidencia/P1.H1.M6-webhook-signature.txt) |
| P2.H1.M1 | Spike TigerBeetle: **SÍ con condiciones**. | [`spikes/tigerbeetle.md`](../../spikes/tigerbeetle.md) | `TESTED` |
| P3.H1.M1 | Spike Temporal: **SÍ con condiciones**. | [`spikes/temporal.md`](../../spikes/temporal.md) | `TESTED` |
| P4.H1.M1 | Spike Banco Mercantil: **no hay API pública**; lista de 15 pedidos al banco. | [`spikes/banco-mercantil.md`](../../spikes/banco-mercantil.md) | `DISCOVERED` |

Además, y fuera de las microtareas contadas: `@pay/outbox` (outbox, relé con candado y retroceso, inbox y publicador NATS JetStream; **19 pruebas** contra Postgres y NATS reales, y dos mutaciones deliberadas, sin `Nats-Msg-Id` y sin candado, que las pruebas detectaron) — [evidencia](./evidencia/outbox-tests.txt). Gates del repo: `yarn typecheck`, `yarn lint` (23 archivos), `yarn build` y `yarn test` (129 pruebas) con salida 0 — [typecheck](./evidencia/gate-typecheck.txt), [lint](./evidencia/gate-lint.txt), [build](./evidencia/gate-build.txt), [test](./evidencia/gate-test.txt).

## A medias

### P1.H1.M1 — Compose local
- **Qué anda:** postgres (un rol y una base por servicio), nats, redis, temporal, jaeger y watchman en `healthy` ([evidencia](./evidencia/P1.H1.M1-compose.txt)); separación de bases 99/99 ([evidencia](./evidencia/P1.H1.M8-separacion.txt)).
- **Qué no anda:** TigerBeetle, Svix y OpenBao (perfil `full`) no se ejecutaron.
- **Qué falta:** correr `--profile full` con acceso a ghcr.io y Docker Hub, y confirmar los tres *healthchecks* y comandos.
- **Dónde quedó:** `platform/compose.yml`; valida con `docker compose config`.

### P1.H1.M7 — Contratos y CI de contratos
- **Qué anda:** esquema CloudEvents; `yarn contracts:lint` valida 7 OpenAPI y 4 AsyncAPI; 333 mutaciones inválidas rechazadas en los ejemplos de eventos.
- **Qué no anda:** no hay detección de cambios que rompen.
- **Qué falta:** integrar `oasdiff` (u otra) y probarlo con un PR que borre un campo requerido.
- **Dónde quedó:** `contracts/scripts/lint-contracts.mjs`.

### P1.H1.M8 — CI reutilizable
- **Qué anda:** prueba de separación y verificación de la plantilla, ejecutables a mano; `.github/workflows/ci.yml` escrito.
- **Qué no anda:** el workflow nunca corrió en GitHub.
- **Qué falta:** un PR que lo dispare y su salida.
- **Dónde quedó:** `.github/workflows/ci.yml`.

### P3.H3.M1 — Spike `hyperswitch-card-vault`
- **Qué anda:** revisión documental completa y licencia Apache-2.0 confirmada.
- **Qué no anda:** no se ejecutó (imagen inaccesible; el sistema de permisos denegó clonar y compilar código de terceros).
- **Qué falta:** levantarlo en un entorno con acceso y probar crear, consultar y borrar un token.
- **Dónde quedó:** [`spikes/card-vault.md`](../../spikes/card-vault.md).

### P5.H2.M1 — Spike Watchman
- **Qué anda:** API y latencia (p99 < 30 ms, un cliente) con datos congelados de 2019.
- **Qué no anda:** no se cargaron las listas vigentes; el puntaje de una coincidencia exacta fue 0,812.
- **Qué falta:** caché propio de listas, medición bajo concurrencia y umbrales de cumplimiento (Q-12).
- **Dónde quedó:** [`spikes/watchman.md`](../../spikes/watchman.md).

## Pendiente

Las otras 99 microtareas son 94 en `TODO` y las 5 `A MEDIAS` descritas arriba (ver cada carril). Lo que destraba lo más cercano:

| Qué | Estado | Qué lo destraba |
|---|---|---|
| Congelar contratos (`v1-frozen`) | TODO | Nombres de P1–P5 (Q-10) y revisión cruzada de cada contrato; resolver Q-15 a Q-19 |
| `pay-edge`, `pay-webhooks` y los otros 10 servicios | TODO | Cada dueño genera su servicio con `new-service.sh` (Q-10) |
| Capa sandbox (D-26): `pay-mockbank`, semillas y `yarn e2e` | TODO | Ola 4; el simulador básico (P4.H1.M4) llega en la ola 1 |
| Conectores reales del Banco Mercantil | TODO | Que alguien pida al banco los 15 puntos (Q-11) |

## Evidencia

Índice en [`evidencia/`](./evidencia/): `P1.H1.M1-compose` · `P1.H1.M2-plantilla` · `P1.H1.M3-money` · `P1.H1.M4-problem` · `P1.H1.M5-idempotency` · `P1.H1.M6-webhook-signature` · `P1.H1.M7-contratos` · `P1.H1.M8-separacion` · `outbox-tests` · `gate-typecheck` · `gate-lint` · `gate-build` · `gate-test`. Spikes en [`../../spikes/`](../../spikes/).

## No cubierto

- **Nada de esto se probó en GitHub Actions** ni en Coolify.
- **TigerBeetle:** una sola réplica; no se probó multi-réplica, recuperación de un nodo caído ni rendimiento a 100.000 pagos/día. **Temporal:** no se midió HA ni carga.
- **Svix, OpenBao y card-vault:** solo revisión documental (no se ejecutaron).
- **Rendimiento de todo el conjunto:** ninguna prueba de carga (T-01 sigue abierta).
- **Seguridad:** no se hizo la matriz de autorización negativa de `pay-edge` (no existe todavía) ni revisión PCI; el único hallazgo automático (puertos del Compose en todas las interfaces) se corrigió.
- **`@pay/webhook-signature` `v1a`:** no hay oráculo externo; la codificación de bytes de las claves es una decisión mía por un spec ambiguo (Q-14).
- **Los contratos** no se probaron contra implementaciones: solo validan sintaxis y consistencia interna.

## Desvíos del plan

- Los spikes y el borrador de contratos los hicieron cuatro agentes en paralelo; yo verifiqué el lint de contratos y la consistencia, y integré sus hallazgos al plan. Los contratos **no los escribieron sus dueños** (todavía no existen).
- Este entorno no llega a Docker Hub directo: se usó el espejo `mirror.gcr.io` (variable `HUB`). Watchman se movió al perfil por defecto con la imagen `v2-static` porque la de ghcr/`latest` no arranca sin internet.
- Se agregó `pay-mockbank` (D-26) y la ola 4; INT pasa a ola 5. Se sumaron P1.H1.M9, P2.H1.M9, P1.H5 (5) y P4.H4 (5): el plan pasó de 95 a 107 microtareas.
- Bugs míos encontrados por las propias pruebas y corregidos: comparación de `locked_at` por milisegundos contra microsegundos (idempotencia), `SERVICE_CONFIG` sin módulo global (plantilla), `paths` del typecheck que rompían el build, `pay_test` abierta a todos los roles, y un `cleanup` con ruta relativa en `verify-template.sh`.

## Riesgos residuales

- Contratos redactados sin sus dueños: pueden no encajar con lo que cada uno entienda; por eso siguen en `draft`.
- El mock (D-26) puede desviarse del banco real; la mitigación es la suite de contrato compartida (P1.H5.M4), que todavía no existe.
- Las credenciales del Compose son de desarrollo y Redis/NATS no tienen autenticación (aceptado: solo escuchan en `127.0.0.1`; **no usar ese archivo en un servidor**).

## Decisiones y ambigüedades

- Nuevas: D-26 (capa mock). Abiertas, con a quién preguntar: Q-11 a Q-19 en [`DECISIONES.md`](../../plan/DECISIONES.md). Corrección a la investigación inicial: Formance **no** es «MIT confirmada» (H-LIC1).
