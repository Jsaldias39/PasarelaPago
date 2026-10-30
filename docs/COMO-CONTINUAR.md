# Cómo continuar en local

Guía para clonar este repo y seguir. Todo lo que dice acá está **verificado en la rama** salvo lo marcado `SIN VERIFICAR`.

## 1. Qué clonar

| Repo | Rama | Qué tiene |
|---|---|---|
| `Jsaldias39/pasarelapago` (antes `PasarelaPago`) | `claude/adoring-allen-ly7r6f` | La pasarela completa (12 servicios, contratos, arnés e2e, docs). **No hay ningún PR abierto**; `main` y `dev` no recibieron nada. |
| `mdavila-2001/mantra-core-health-api` | `claude/adoring-allen-ly7r6f` | Carril INT: el monolito cobra por la pasarela detrás del flag `PAYMENTS_VIA_GATEWAY` (apagado por defecto). Sin PR. |
| `mantra-core-technologies/mantra-core-health-model` | `claude/adoring-allen-ly7r6f` | Los 12 modelos `pay_*` (`.puml` → `SQL/pay/` → `gen_ddl_pay.py --check`). Sin PR. |

Estado y reglas: [`PLAN-MAESTRO.md`](plan/PLAN-MAESTRO.md) (avance recalculado desde las tablas de los carriles), [`DECISIONES.md`](plan/DECISIONES.md) (D-01…D-33), `CLAUDE.md` (reglas del repo: lo primero que hay que leer).

## 2. Requisitos

- Linux x86_64 (o WSL2), **Node ≥ 22**, **Corepack** (Yarn 4.14.1 sale de `packageManager`), **Docker** con Compose, ~8 GB de RAM libres y 4 vCPU. Con menos CPU las pruebas de tiempos se vuelven intermitentes (nos pasó).
- `yarn install` (Yarn 4; no usar npm).
- Si tu red no llega a Docker Hub/ghcr.io: `HUB=mirror.gcr.io` sirve Postgres, NATS, Redis, Temporal, Jaeger, Watchman, **OpenBao y Svix**. TigerBeetle no está ahí: se usa el binario (abajo).

## 3. Levantar la infraestructura

```bash
yarn install
docker compose -f platform/compose.yml up -d --wait     # postgres 54321, nats 54222, redis, temporal 54233, jaeger 54686/54318, watchman
platform/scripts/tigerbeetle-dev.sh start                # TigerBeetle por binario (la imagen de ghcr.io no siempre baja)
# Solo para probar pay-connectors (OpenBao) y pay-webhooks (Svix):
HUB=docker.io docker compose -f platform/compose.yml --profile full up -d --wait openbao
HUB=docker.io SVIX_WHITELIST_NAMES='["receptor.comercio.example"]' SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION=true SVIX_RETRY_SCHEDULE=1,2,3 \
  docker compose -f platform/compose.yml --profile full up -d --wait svix-db svix
```

Las tres variables de Svix son **solo de pruebas** (cerradas por defecto en el compose). Sin ellas las suites de `test/svix/` fallan con «Svix no está listo».

- **No uses `--profile full up` sin nombrar servicios**: arrastra la imagen de TigerBeetle de ghcr.io, que no siempre baja (403). Nombrá `openbao`, `svix-db`, `svix` como arriba.
- Si el contenedor/VM se reinicia, hay que volver a levantar Docker, el compose y TigerBeetle; Postgres hace recuperación de arranque (~20 s) y el puerto de TigerBeetle tarda en abrir.
- El TigerBeetle de desarrollo acumula transferencias de corridas anteriores y el reconciliador de arranque de `pay-ledger` las lee: si las suites del ledger se arrastran, `platform/scripts/tigerbeetle-dev.sh reset` (solo desarrollo; borra sus datos).

## 4. Verificar (los gates reales)

```bash
yarn contracts:lint && yarn contracts:events && yarn lint          # contratos y eslint de todo el repo
cd services/<servicio> && yarn typecheck && yarn build && yarn test   # por servicio (12)
yarn e2e:typecheck && yarn e2e                                       # suite e2e completa (~8 min, 12 servicios reales, UN stack a la vez)
yarn e2e e2e/flows/e1-payer.e2e.ts                                   # un flujo aislado
yarn test:parity                                                     # paridad mock/real del conector (exit 0)
yarn load:harness --rps 5 --minutes 3                                # carga (criterios en docs/trabajo/ola-3/P1/CARGA.md)
```

Resultados de referencia en esta rama (máquina de 4 vCPU), corrida final con `yarn test --runInBand` por servicio: pay-edge 452, pay-webhooks 616, pay-payments 37 suites (37/37), pay-vault 150, pay-qr 121, pay-mockbank 161, pay-settlement 596, pay-merchants 213, pay-risk 244, pay-schedules 213; `yarn e2e` 36 suites / 274 tests (273 + E7 re-corrida en verde tras corregir un falso positivo del escáner, ver §8); `yarn test:parity` exit 0; carga APRUEBA a 5 rps y NO APRUEBA a 10 y 25 rps por saturación del host (no del código; invariantes de dinero intactas). La evidencia literal está en `docs/trabajo/ola-5/integracion/evidencia/verificacion-final*.txt`; **léela junto con §8 antes de fiarte de un verde o de un rojo**.

Corré los servicios con **un solo worker** (`yarn test --runInBand`, regla 70.3): con 2 workers `pay-payments` falla `payment.kill.spec.ts` y `ola2.tanda2g.refund.spec.ts` (pasan aisladas y en serie; la causa de la interferencia entre suites no está demostrada).

Reglas prácticas del arnés: **un stack a la vez** (hay candado en `e2e/.run/stack.lock`; `yarn e2e:down` limpia restos), no correr dos `yarn e2e` en paralelo, y `pay-connectors` / `pay-webhooks` necesitan OpenBao / Svix arriba para sus suites.

## 5. Qué está hecho y qué no

91 / 109 microtareas HECHO. Las 18 que faltan, por motivo:

| Qué | Por qué falta | Qué lo destraba |
|---|---|---|
| P1.H1.M1, P1.H5.M1 — Compose completo y capa sandbox en contenedores | La imagen de TigerBeetle (ghcr.io) y los builds de `Dockerfile.sandbox` no se pudieron probar acá (403 / 429 / TLS interceptado). `docker compose config` es válido. | Tu máquina con acceso normal: `docker compose -f platform/compose.yml -f platform/compose.mock.yml --env-file platform/.sandbox/secrets.env up -d --wait` (antes `yarn sandbox:secrets`). **SIN VERIFICAR.** Ver `docs/trabajo/ola-4/P1/BLOQUEOS.md`. |
| P1.H1.M8, P1.H1.M7 — CI | El CI nunca corrió en GitHub. | Abrir un PR/push a `dev` y mirar el flujo; instalar `oasdiff` en el CI. |
| P1.H4.M3, P3.H3.M2 — red aislada de `pay-vault` | Requiere Coolify. | Acceso al proyecto de pagos en Coolify. |
| P1.H4.M1 — mapa PCI | Falta revisión de P3 y de un QSA. | Personas. |
| P1.H2.M3 — traza y mTLS | La propagación de trazas se está corrigiendo; mTLS es una **decisión tuya** (`docs/trabajo/ola-5/P1/MTLS-DECISION.md`). | Decidir; ver la fila. |
| P3.H3.M1 — spike del vault de Hyperswitch | La imagen no está en el espejo. | Acceso a su registro. |
| P2.H2.M6b, P4.H2.M3, P4.H2.M4, P4.H3.M3, P5.H2.M1 | Formato real del Mercantil (Q-11), cuenta recaudadora y visto bueno legal (T-03), manual del BCB, licencias. | El banco y el dueño. **Nada se inventó.** |
| INT.H1.M1, M4, M5 | `sk_live_` con cuenta recaudadora (T-03), datos reales de Libélula, dos cortes semanales sin uso. | Negocio. |
| INT.H1.M2 — cobro detrás del flag | Probada contra dobles y el sandbox real; faltan las confirmaciones 1–4 de `docs/trabajo/ola-5/INT/INFORME.md` y la persistencia del camino de cobro. | P3 y el dueño de M42. |

## 6. Decisiones que solo vos podés tomar

1. **mTLS en aplicación** vs segmentación de red + identidad firmada (`MTLS-DECISION.md`). Hoy `x-service-id` es una cadena sin firma: protege de errores de cableado, no de un atacante con alcance de red. **S-01: es BLOQUEANTE para `live`** (`docs/trabajo/ola-5/integracion/revision/PENDIENTES-SEGURIDAD.md`, que también lista S-04 —alfabeto del token de la bóveda— y S-05 —cota de edad de la réplica de claves—).
2. **PR-18**: `pay-schedules` ejecuta contra el libro mayor sin pasar por riesgo ni emitir `payment_intent.*`.
3. **DT-19**: el guardia de PAN da falsos positivos (se vio con un UUID en `metadata`); exigir el prefijo de marca (IIN) o excluir UUID.
4. Triggers append-only de 9 tablas sin guardián (ver `docs/trabajo/ola-2/CONTRATOS.md` §6).
5. Si `SQL/pay/` queda dentro de `SQL/` del repo del modelo.
6. Cuatro decisiones del stakeholder: quién adjudica el seguro (#160), si AloVida es la pasarela (#122), supermercado (#161), teleconsulta (#162).

## 7. Antes de producción (no negociable)

- **Svix:** fijar `SVIX_MAIN_SECRET` **antes** de guardar la primera clave (no se puede cambiar después; sin él las claves de firma quedan sin cifrar). Además `webhook-id` de Svix es su `msg_…`, no el id del CloudEvent: contradice DT-24 (propuesta #1 en `docs/trabajo/ola-5/P1/PROPUESTAS.md`).
- **Bajo `PAY_MODE=live`**: `pay-connectors` exige `SECRET_PROVIDER=openbao` (https + AppRole) y `pay-webhooks` exige `WEBHOOKS_ENGINE=svix` (https + JWT). Ver `docs/runbooks/sandbox-a-produccion.md` §6.
- **No se mueve dinero real** sin cuenta recaudadora y visto bueno legal (T-03). El rail del modo B es un doble declarado.
- **API (`mantra-core-health-api`)**: la bandera `PAYMENTS_VIA_GATEWAY` va **apagada**; una reserva de despacho vencida sigue bloqueando hasta conciliarla (`GET /payments/gateway-dispatches/pending-reconciliation`, `POST …/:intentId/reconcile|close`, la conciliación exige riesgo aprobado). Falta decidir `RLS_ENFORCE` en producción y correr INT.M2 contra el sandbox completo.
- Las bases de desarrollo compartidas con DDL anterior a ola 5 **no tienen** las guardas append-only (`docs/runbooks/sandbox-a-produccion.md` §7.1); no se tocaron a propósito. Con pay-risk caído, un cobro tarda ~13–17 s en fallar (a confirmar con producto).
- Los secretos del repo son de **desarrollo** (`dev-only-*`). Un literal con forma de clave `sk_live_` bloquea el push (protección de secretos de GitHub): armalo en ejecución en los tests.

## 8. Trampas conocidas

- Día 29–31 del mes: `day_of_month` máximo es 28; los tests usan `min(día, 28)`.
- `@pay/idempotency` guarda y repite **24 h** todo error < 500 bajo la misma clave: un reintento tras un 422 necesita clave nueva; tras un resultado ambiguo (timeout/5xx/409-en-curso) la **misma**.
- Un timeout NO cuenta como falla del circuit breaker del cliente de riesgo (regla 11).
- **E7 (escáner de PAN)**: la identidad del worker de Temporal (`buildId`, un hash hexadecimal de 64 caracteres) puede contener por azar una tira de dígitos válida por Luhn y el detector la tomaba por una tarjeta. `historyText()` en `e2e/lib/sensitive-sources.ts` la excluye; los payloads se siguen leyendo enteros.
- `pay-ledger` `deployment.spec`: las 31 pruebas pasan en ~3 s pero el proceso de Jest no terminaba (pools de `pg`/ORM creados antes de que un `compile()` lance); por eso `forceExit` en `services/pay-ledger/jest.config.cjs`.
- `pay-ledger` `separation.spec` falló una vez con 42 *timeouts* de conexión a la vez y pasó 4/4 aislada: transitorio sin causa demostrada; si se repite, tratalo como bug hasta probar lo contrario (no subas el timeout).
- Workflows de Temporal sintéticos quedan abiertos tras pruebas de carga y consumen CPU: se limpian con `temporal workflow terminate --query 'ExecutionStatus="Running"'` en el contenedor.
