> **AVANCE del carril P4: 17 / 22 microtareas HECHO — 77,3 %** (`docs/plan/carriles/P4-conectores-ruteo-y-qr.md`). Esta página no cambia ese número: es la matriz de gates de la ola 3 (PLAN-MAESTRO §7).

# Gates de la ola 3 — P4 (`pay-connectors`, `pay-qr`, `pay-mockbank`)

- Fecha: 2026-10-28 · Rama: working tree sin commit · Modelo vendorizado: **`af60b79`** (`mantra-core-health-model`, esquema `70_pay_connectors` y el de `pay-qr`; `vendor-ddl.sh --check` exit 0).
- Peldaño de evidencia (regla 30): **`TESTED`** para el código; **`VERIFIED`** para los gates de proceso real (separación, datos sensibles, pool/Postgres cortado, imagen en ejecución). `REGRESSION_VERIFIED` no se declara: faltan el contrato consumidor y el E2E de la ola 4.
- Toda la evidencia está en [`evidencia/`](./evidencia/) con salida literal. Prefijos: `3a-` gates, `3b-` deriva/vendorizado, `3c-` modelo estable, suites completas y defecto del pool.
- Reproducción: `scripts/run-gates.sh` (suites completas ×2, una a la vez, `--maxWorkers=2`).

## Matriz

| # | Gate | Veredicto | Evidencia (literal) | Qué falta y de quién |
|---|---|---|---|---|
| 1 | Typecheck, lint y unitarios | **PASS** | `3c-{mockbank,connectors,qr}-typecheck/build` exit 0 · `3c-*-test-1/-2`: mockbank **141/141** ×2, connectors **788 pasan + 23 `todo`** ×2, qr **121/121** ×2 · `3a-eslint-servicios` exit 0 · `3a-yarn-lint` (raíz) exit 0 | — |
| 2 | Integración contra base real | **PASS** | `3a-integracion-base-real`: 0 `jest.mock`/`mockResolvedValue` en los tres servicios; el único doble (`jest.spyOn(mock,'createCharge')` en `end-to-end.spec.ts`) está declarado | TigerBeetle no aplica a P4 |
| 3 | Contrato | **PASS del lado proveedor · GAP del lado consumidor** | `3a-contrato-mock`: suite por conector `CONNECTOR=mock` 37 pasan + 5 `todo`; respuestas de connectors/qr validadas contra `internal-*-v1.yaml` (`ola2-contratos`, `qr.spec`); las de mockbank contra su propuesta (`mockbank-v1.proposal.yaml`) | **GAP (P1/P3):** tests de consumidor generados desde OpenAPI/AsyncAPI. **BLOCKED:** `mercantil_qr`/`mercantil_card`/`bank_transfer` real, sin documentación ni credenciales del banco (D-16) |
| 4 | Idempotencia en paralelo | **PASS** | connectors: 20 pedidos simultáneos misma clave ⇒ 1 cobro y 1 QR (×5 corridas), 5 reembolsos de Bs 30 sobre Bs 100 ⇒ exactamente 3, 12 envíos del mismo id nunca se superponen (`3c-concurrencia-connectors`: 58 pasan) · mockbank: **30** pruebas (`3a-idempotencia-mockbank`) · qr: 20 simultáneos ⇒ 1 QR (`3a-idempotencia-qr`) | — |
| 5 | Autorización negativa | **PASS parcial** | Sin identidad / otro servicio ⇒ 403 en todas las operaciones (`3a-autorizacion-identidad-*`: connectors matriz completa; qr 6 rutas; mockbank 6 rutas). `X-Pay-Mode` ausente, vacío, mayúsculas, doble, del despliegue, `live` contra sandbox, `test` contra live ⇒ 403 **sin efecto** (`3a-autorizacion-{connectors,qr,mockbank}`: 94 / 48 / 2 pasan). Id del OTRO modo ⇒ 404 igual que uno inexistente | **GAP (P1/P3): «otro comercio»** — las APIs internas no reciben el comercio de quien llama; el aislamiento lo imponen `pay-edge`/`pay-payments` (propuesta #15). **NO APLICA: «clave revocada»** — las claves viven en `pay-edge`/`pay-merchants` |
| 6 | Separación | **PASS** | `3a-separacion`: los tres servicios arrancan y operan con su propio rol `pay_<svc>`; 13/13 conexiones a bases ajenas denegadas | — |
| 7 | Datos sensibles | **PASS** | `3a-datos-sensibles` (`scripts/sensitive-data-scan.mjs`): procesos reales con `LOG_LEVEL=trace`; centinelas PAN (variantes), CVV, documento y nombre; control positivo y negativo; **0 apariciones** en logs, errores, eventos, base y trazas OTLP | — |
| 8 | PCI | **PASS con corrección pendiente en doc ajeno** | `docs/cumplimiento/pci-alcance.md`: línea 29 `pay-connectors` «CDE (provisoria)» (diseño: hoy el código no llama a `reveal` ni toca un PAN); línea 38 `pay-qr` «Fuera de alcance» (confirmado por el escáner); línea 39 `pay-mockbank` dice «Procesa números de tarjeta de prueba» — **incorrecto**: solo acepta `tok_…` y rechaza PAN con 422 (`pan-guard.spec.ts`, `bank-api.spec.ts`) | **P1/P3:** aplicar la corrección de la línea 39 (propuesta #10, texto exacto allí). No edité un documento que no es mío |
| 9 | Deriva de esquema | **PASS** | `3b-drift-connectors` 8/8, `3b-drift-qr` 8/8 (tabla ausente, columna ausente, obligatoria sin mapear, nulabilidad divergente + control negativo mutando el mapa) · `3b-vendor-check-*`: «`sql/ddl.sql` coincide con el modelo (af60b79…)» exit 0 | `pay-mockbank` no está en el modelo (D-26: doble de sandbox, esquema propio `001_mockbank.sql`) |
| 10 | Observabilidad (traza E1 en Jaeger) | **NO APLICA AÚN** | Requiere el arnés E2E completo con los 11 servicios; no se levanta en esta tanda por instrucción | P1 (arnés). Lo que sí está: exportador que depura PII (`scrub.spec`) y captura OTLP en el escáner |
| 11 | Fallos | **PASS** | `3a-fallos-connectors` 12/12 (base caída, 5 corridas de callbacks duplicados con 1 de cada 3 conexiones rechazada, transferencias con candados rechazados), `3a-fallos-qr` 2/2, `3a-fallos-mockbank` 3/3 · **nuevo:** corte de Postgres a mitad de servicio, ver «Defecto del pool» | — |
| 12 | Carga (T-01) | **NO APLICA AÚN** | Se mide sobre el stack completo contra Coolify con criterio de P1 | P1 |
| 13 | Sandbox E2E | **NO APLICA AÚN** | Ola 4 | P1/P2 (arnés) |
| 14 | Dockerfile | **GAP (construcción de producción) · PASS (imagen de ejecución)** | `3a-docker`: `docker build` de producción de los 3 ⇒ exit 1 (`YN0028`: `install --immutable` quiere reescribir `yarn.lock` porque la plantilla copia solo 2 de los 12 workspaces; diagnóstico offline en `3a-docker-lockfile-diagnostico`; además el registro no es alcanzable desde el contenedor: `SELF_SIGNED_CERT_IN_CHAIN`). Imagen de ejecución (`Dockerfile.runtime-check`: node:22-alpine, `USER node`, `CMD node dist/main.js`) **construida y corriendo ×3**: `/health/ready` 200 y `X-Pay-Mode: sandbox` | **P1:** plantilla de Dockerfile (propuesta #11) + proxy TLS del entorno. No lo apliqué en mis Dockerfiles porque no puedo verificarlo de punta a punta |
| 15 | `X-Pay-Mode: sandbox` en la respuesta (cierre de 4b) | **PASS** | `3a-sandbox-header-connectors` 3/3, `3a-sandbox-header-qr` 3/3, mockbank en `3a-autorizacion-mockbank`: en sandbox TODA respuesta (éxito, error, salud) la lleva; en live ninguna; la cabecera de la petición no la cambia | — |

## Higiene de disco (pedido del defecto transversal)

`gate-docker.sh` borra mis imágenes (`docker image rm -f p4gate-…`) y ejecuta `docker builder prune -f` **después de cada `docker build`**, e imprime `df -h /` antes, tras cada servicio y al final. Salida literal en `3a-docker`: imágenes `p4gate-*` restantes = **0** tras cada servicio; libre antes de empezar 11 G (73 %), tras connectors 11 G, tras qr 9,5 G (76 %), tras mockbank 9,8 G, al terminar 9,7 G (75 %). La imagen base `node:22-alpine` se conserva (la usan otros).

## 3c — modelo estable (`af60b79`)

| Pedido | Resultado |
|---|---|
| Re-vendorizar y `--check` | **PASS** (`3b-vendor-check-*`, exit 0, commit `af60b79`) |
| `reset()` de `test/support/app.ts`: de `TRUNCATE` a `DELETE` en orden de FK | **HECHO con desvío declarado.** Las tablas de dinero (`connector_charges`/`transfers`/`refunds` y dependientes) se vacían con `DELETE` en orden de FK, porque ahora el modelo rechaza `TRUNCATE` ahí. Las tres tablas **técnicas** (`idempotency_keys`, `outbox_events`, `inbox_events`) siguen con `TRUNCATE`: `DELETE FROM outbox_events` chocaba con el `UPDATE … published_at` del relé y daba `deadlock detected` (el log de Postgres lo mostró), y no tienen guardián |
| Pruebas por restricción (3 niveles) | **PASS** `3c-money-guards-connectors` 6/6: correcto (`send_claims` sube; `ambiguous` true→false permitido), límite (dejarlo igual con otras columnas cambiadas sí; bajarlo en 1 no; tabla sin guardián sigue vaciable), inválido (`send_claims` a 0 o negativo; `TRUNCATE` rechazado en las 3 tablas, con CASCADE) |
| Triggers append-only para `connector_callback_events` y `connector_api_attempts` | **Evaluado: SÍ, las dos** (el código solo hace `INSERT`; son la huella de dedupe/auditoría de lo que dijo el banco y el registro de la regla 11). Riesgos y condiciones (`reset()` y DELETE, retención, volumen ⇒ guardián solo de UPDATE/DELETE/TRUNCATE y medirlo en T-01): propuesta #12. **No implementado**, como se pidió |
| Borrar `001_*.sql` | **HECHO** en connectors y qr (solo queda `sql/ddl.sql` vendorizado) tras ≥2 corridas verdes de todo, incluidas las suites de concurrencia (`3c-concurrencia-connectors`). `pay-mockbank` conserva `001_mockbank.sql`: no está en el modelo |

## Defecto del pool (`pg.Pool` sin manejador de `error`)

- **Qué pasaba:** Postgres corta una conexión (reinicio, failover, `pg_terminate_backend`) y Node trata el `error` sin escuchas como excepción no capturada ⇒ muere el proceso.
- **Arreglo (`src/pool-guard.ts` en cada servicio, usado por `PG_POOL` de los tres y por `LOCK_POOL`):** `pool.on('error', …)` registra **solo** `error.name` («Conexión ociosa cortada por Postgres; el pool la repone») **y** `pool.on('connect', client => client.on('error', () => undefined))`. El pool de MikroORM ya trae su manejador.
- **Hallazgo que va más allá del pedido:** con **solo** `pool.on('error')` (el patrón de `pay-merchants`) el proceso **sigue muriendo** si el corte cae sobre una conexión **prestada** (`pool.connect()`: transacciones, candados, `@pay/idempotency`). Reproducido con el binario real: `3c-pool-error-control-solo-ocioso-connectors` ⇒ pasan las 5 pruebas de conexión ociosa y falla la del corte a mitad de «cobro enviado» (`fetch failed`, el proceso cayó; el error es `Unhandled 'error' event … Connection terminated unexpectedly`). Propuesta #16 con la lista de servicios que copiaron el patrón incompleto.
- **Pruebas** (`test/pool-error.spec.ts` en cada servicio, proceso real `node dist/main.js` + Postgres real; los backends del proceso se identifican con `lsof` y se conecta directo a `inet_server_addr()` porque detrás de `docker-proxy` el servidor ve otro puerto de origen):

| Nivel | connectors (6) | qr (5) | mockbank (5) |
|---|---|---|---|
| Correcto | una ociosa cortada ⇒ proceso vivo, `/health/ready` 200, el pool repone; `LOCK_POOL` cortado ⇒ sigue y repone | ídem | ídem |
| Límite | **todas** las ociosas a la vez ⇒ 4 peticiones concurrentes 201; corte **a mitad de una lectura** ⇒ 5xx `problem+json`, nunca «no existe», el cobro intacto; **regla 11:** corte tras enviar al proveedor, en la escritura de «cobro enviado» ⇒ 5xx del contrato, el cobro queda `pending` + `ambiguous=true` (ni cancelado, ni fallido, ni borrado) y reintentar con la **misma clave** converge en **un** cobro | ídem + corte a mitad de la transacción de escritura ⇒ reintento converge en **un** QR | ídem + corte a mitad de la transacción del reembolso ⇒ nada a medias, reintento converge en **un** reembolso |
| Inválido | el registro del proceso **no** contiene el mensaje de Postgres (`terminating connection…`, `57P01`), ni SQL, ni cadena de conexión ni contraseña; **sí** contiene el aviso con `"err":"error"` (control positivo) | ídem | ídem |

  Resultados: `3c-pool-error-{connectors,qr,mockbank}` (6/6, 5/5, 5/5). **Controles negativos por mutación** (el `guardPool` reducido a no-op): `3c-pool-error-control-negativo-{connectors,qr,mockbank}` ⇒ el proceso muere y las pruebas fallan (`ECONNREFUSED`/`fetch failed`); luego se restauró y se verificó que las tres copias son idénticas.
- **No cubierto:** los demás servicios (propuesta #16), ni Postgres reiniciado de verdad (se usa `pg_terminate_backend`, que produce el mismo `57P01` para el cliente), ni el corte durante `COMMIT`.

## Defectos reales encontrados y corregidos en esta ola

1. Reembolso de mockbank: deadlock por agotamiento del pool (la transacción retenía un cliente y pedía otro para `nextval`) — lo atrapó la prueba de paralelismo.
2. Mockbank: dos autorizaciones concurrentes informaban `created:true`; captura y anulación simultáneas ganaban las dos; el pagador cobraba antes de validar el importe.
3. Trazas con PAN/CVV/documento/nombre puestos por el cliente en la URL (`url.full`, `http.target`) ⇒ exportador depurador (`scrub.ts`) en los tres servicios; propuesta #14 para los otros 9.
4. Campos libres de mockbank aceptaban un PAN ⇒ guardia Luhn en ventana de 13–19 dígitos.
5. `/health/ready` devolvía 500 con la base caída ⇒ 503 sin mensaje (propuesta #13 para la plantilla).
6. `charge_sent` podía hacer retroceder el estado de un cobro que un callback ya había avanzado ⇒ precondición en la escritura (`CASE WHEN provider_status='pending'`).
7. **Proceso muerto por corte de Postgres** (esta tanda), ver arriba.

## No cubierto

- Nada se ejercitó contra un banco real: los conectores `mercantil_*` y el real de transferencias siguen sin documentación (D-16); lo verificado es contra `mock`/`pay-mockbank` declarados como dobles.
- Contrato del lado consumidor, traza E1 en Jaeger, carga, E2E de sandbox: ver filas 3, 10, 12, 13.
- La construcción de producción de las imágenes (fila 14).
- La suite de concurrencia se corrió con un filtro (`-t`) en el gate; las suites **completas** ×2 sí la incluyen (788 pruebas).

## Decisiones y ambigüedades

- El tamaño de los pools y la política del pool de MikroORM no se tocaron.
- El manejador de cliente prestado traga el evento `error` en silencio a propósito (el rechazo de la consulta en vuelo ya llega al llamador, que responde con error del contrato y queda en el registro como `Error no controlado` con solo el nombre). A confirmar con P1 si prefieren registrarlo también.
- Las pruebas del pool necesitan `lsof` en la máquina de CI y que el servidor de Postgres sea alcanzable por `inet_server_addr()`; falla con un mensaje explícito si falta `lsof`.

## Índice de evidencia

`evidencia/`: `3a-*` (gates), `3b-*` (deriva y vendorizado), `3c-*` (suites completas, modelo estable y pool). La lista completa con la salida literal de cada comando está en los propios archivos (cabecera `$ comando`, cola `exit=N`).
