> Peldaño: TESTED · Veredicto: SÍ (con condiciones, ver §4)

# Spike P3.H1.M1 — ¿Sirve Temporal para las sagas de `pay-payments`?

- **Fecha:** 2026-10-27 · **Carril:** P3 · **Microtarea:** P3.H1.M1
- **Servidor:** Temporal **1.25.2** (lo informa `getSystemInfo`), imagen `mirror.gcr.io/temporalio/auto-setup:1.25` (`sha256:b1edc1e20002d958c8182f2ae08dee877a125083683a627a44917683419ba6a8`), persistencia en PostgreSQL 16 (`postgres:16-alpine`), un solo contenedor de cada uno.
- **SDK:** `@temporalio/worker`, `client`, `workflow`, `activity` y `core-bridge` **1.24.0**. El binario nativo instaló y cargó sin problemas en este entorno. El workflow del spike está escrito en JavaScript, **no en TypeScript**.
- **Código y salidas:** [`temporal/workflows.js`](./temporal/workflows.js), [`activities.js`](./temporal/activities.js), [`worker.js`](./temporal/worker.js), [`run.js`](./temporal/run.js); salidas literales en [`salida-corrida-1.txt`](./temporal/salida-corrida-1.txt) y [`salida-corrida-2.txt`](./temporal/salida-corrida-2.txt); registro de efectos con marcas de tiempo en [`efectos-corrida-1.jsonl`](./temporal/efectos-corrida-1.jsonl).

## 1 · Cómo se reprodujo

```bash
docker network create spikea-net
docker run -d --name spikea-pg --network spikea-net -e POSTGRES_USER=temporal -e POSTGRES_PASSWORD=temporal mirror.gcr.io/library/postgres:16-alpine
docker run -d --name spikea-temporal --network spikea-net -p 19010:7233 \
  -e DB=postgres12 -e DB_PORT=5432 -e POSTGRES_USER=temporal -e POSTGRES_PWD=temporal -e POSTGRES_SEEDS=spikea-pg \
  mirror.gcr.io/temporalio/auto-setup:1.25
cd docs/spikes/temporal && npm install && node run.js      # ~90 s; escribe en /tmp/spike-a/ (EFFECTS, LEDGER)
```

(`mirror.gcr.io` porque Docker Hub devolvía HTTP 429 en este entorno; con el registro oficial el comando es el mismo.)

## 2 · El workflow

`PaymentWorkflow({ intentId, expireMs, failNotify })`:

1. **(a)** `createCharge` → apila la compensación `cancelCharge`.
2. **(b)** `condition(() => confirmed, expireMs)`: espera la **señal** `confirmPayment` o el **vencimiento**.
3. **(c)** `recordLedger(intentId, "ledger-<intentId>")`, idempotente por id → apila `reverseLedger`.
4. `notify` (paso final; con `failNotify` lanza un `ApplicationFailure.nonRetryable`).
5. **(d)** ante cualquier fallo, las compensaciones corren **en orden inverso** al de su registro.

*Interpretación:* el enunciado del spike nombra las compensaciones como «(d)» y pide probar «fallo en el paso (d)». Lo leí como «un fallo después de haber dejado efectos dispara las compensaciones»; por eso el fallo se inyecta en `notify`, **después** del ledger. Si la intención era otra cosa, hay que repetirlo.

Cada ejecución de una actividad agrega una línea a un archivo (`act`, `ev`, `pid`, `t`), así que los conteos de abajo son **ejecuciones reales**, no lo que informa Temporal. El «ledger» sintético es un archivo con un id por línea.

## 3 · Pruebas y resultados

Corrida 1 (la corrida 2 dio lo mismo salvo los tiempos y los pid):

| # | Prueba | Salida literal recortada | Qué demuestra |
|---|---|---|---|
| T1 | Camino feliz | `{"status":"succeeded","compensated":[]}` · efectos `createCharge.commit:1, recordLedger.start:1, recordLedger.commit:1, notify.commit:1` | Señal → ledger → notify, cada paso una vez. |
| T2 | Vencimiento sin señal (`expireMs=3000`) | `{"status":"expired","compensated":["cancelCharge"]}` en **3204 ms** · efectos `createCharge.commit:1, cancelCharge.commit:1` | El *timer* dispara la compensación; el ledger no se tocó. |
| T3 | Fallo en el paso final | `{"status":"failed","compensated":["reverseLedger","cancelCharge"],"error":"notify rechazado (fallo inyectado)"}` · orden real: `createCharge, recordLedger.start, recordLedger.commit, notify.rejected, reverseLedger, cancelCharge` | Las compensaciones corren **en orden inverso**. |
| T4 | **`kill -9` del worker con el workflow esperando la señal** | Estado tras la muerte (pid 16726): `{"status":"RUNNING"}`. Se relanza el worker (pid 16895) y se envía la señal: `{"status":"succeeded"}` en **10,2 s**. Efectos: `createCharge.commit:1, recordLedger.start:1, recordLedger.commit:1, notify.commit:1`. Ejecutaron actividades **dos pid distintos**: `[16726,16895]`. | El estado del workflow sobrevivió a la muerte del proceso. `createCharge` **no** se repitió. Cada actividad se ejecutó **exactamente una vez**. |
| T5 | **`kill -9` del worker con `recordLedger` EN EJECUCIÓN** | Justo después de la muerte: `{"createCharge.commit":1,"recordLedger.start":1}` (sin `commit`). Tras relanzar: `{"status":"succeeded"}` · efectos `recordLedger.start:2, recordLedger.commit:1, notify.commit:1` · **líneas `ledger-t5` en el ledger: 1** | La actividad se **ejecutó dos veces** (start ×2) y el **efecto ocurrió una sola vez** (commit ×1, una línea en el ledger). |
| T6 | `recordLedger` llamada dos veces con el mismo id, fuera de Temporal | `{"primera":{"applied":true},"segunda":{"applied":false}}` | La idempotencia la da el id en la actividad, no Temporal. |

Cronología de T5 (de `efectos-corrida-1.jsonl`): `+0,1 s` primer `recordLedger.start` (pid 17312, luego muerto) → `+8,8 s` segundo `start` (pid 17383, worker relanzado) → `+14,8 s` `commit {applied:true}` (la actividad tiene una espera de 6 s a propósito) → `+14,9 s` `notify`.

## 4 · Hallazgos y condiciones

| ID | Hallazgo | Consecuencia |
|---|---|---|
| H-1 | **Temporal ejecuta las actividades *al menos una vez*, no exactamente una.** En T5 el cuerpo de `recordLedger` arrancó dos veces. | «El ledger se ejecuta exactamente una vez» es cierto **para el efecto**, y solo porque la actividad es idempotente por id. Condición para P3: **toda actividad con efecto externo lleva un id derivado del intento** (y el ledger, el conector y los eventos tienen que aceptarlo, como ya exige el plan). Un id derivado solo del intento choca con `id_already_failed` de TigerBeetle: ver el spike de TigerBeetle, H-1. |
| H-2 | El reintento de una actividad cuyo worker murió **espera al `startToCloseTimeout`**. En T5 el segundo `start` salió a ~8,7 s del primero con un timeout de 8 s. | El timeout de cada actividad fija cuánto tarda la recuperación. Elegirlo por actividad, no uno global. |
| H-3 | Con el worker muerto y el workflow en espera, T4 tardó **10,2 s** desde la señal hasta terminar (en las dos corridas). | **Hipótesis, no verificada:** coincide con el *timeout* por defecto de 10 s de la cola «pegajosa» (*sticky*) que Temporal aplica antes de reencolar. No cambié ese parámetro para comprobarlo. Es el costo de latencia de una caída de worker. |
| H-4 | Una sola ejecución del workflow resolvió los tres desenlaces (éxito, vencimiento y fallo con compensación) con el mismo código. | Encaja con la saga de `pay-payments` (cobro, reembolso, anulación). |

**Condiciones del SÍ:** actividades idempotentes por id (H-1); timeouts por actividad (H-2); aceptar un costo de recuperación de varios segundos tras la caída de un worker (H-2, H-3).

## 5 · Veredicto

**SÍ sirve para `pay-payments`.** Criterio (DoD de P3.H1.M1 y REQ-P3-4): el workflow tiene que terminar tras la muerte del worker, con la actividad del ledger sin efecto duplicado. Cumplido en **T4** (una sola ejecución) y **T5** (dos ejecuciones, un efecto), en las dos corridas. La compensación en orden inverso (T3) y el vencimiento (T2) también se cumplieron.

## 6 · No cubierto

No se ejercitó y **no se afirma**:

- **Producción de Temporal:** alta disponibilidad, varios nodos del servidor, base de datos dedicada, visibilidad avanzada, retención, copias de seguridad, métricas. El spike usó **un** contenedor `auto-setup` con un Postgres. Tampoco se evaluó si esa imagen es apta para producción.
- **TypeScript y NestJS:** el workflow es JavaScript; no se probó el empaquetado de workflows en TypeScript ni la integración con un servicio NestJS.
- **Evolución del código del workflow** con ejecuciones en curso (versionado, `patched`/`getVersion`), historiales largos y `continue-as-new`.
- **Inicio idempotente del workflow** (`workflowId` único, política de reuso, *signal-with-start*): cada prueba usó un `workflowId` nuevo.
- **Cancelación** de un workflow en curso, señales a un workflow ya terminado, varios workers compitiendo por la misma cola, y concurrencia (miles de workflows).
- **Rendimiento y latencia** en general: solo se vieron tiempos de pruebas individuales (T2: 3,2 s; T4: 10,2 s). La carga de 100.000 pagos/día **no está medida**.
- Se mató al worker con `kill -9` (proceso), **no** con `docker kill` ni apagando el servidor de Temporal. La caída del propio servidor o de su Postgres no se probó.
- El ERROR `unable to list search attributes: Namespace default is not found` del log de arranque apareció antes de que `auto-setup` creara el namespace y se resolvió solo (`Update namespace succeeded`); no se investigó más.

## 7 · Licencia verificada

| Componente | Licencia | Cómo se verificó |
|---|---|---|
| `temporalio/temporal` (servidor) | **MIT** | `LICENSE` de `main` en `raw.githubusercontent.com`: «The MIT License · Copyright (c) 2025 Temporal Technologies Inc.», con una segunda línea «Copyright (c) 2020 Uber Technologies, Inc.» (`sha256` `6aab9afd99ceb1dc…`) |
| `temporalio/sdk-typescript` | **MIT** | `LICENSE` de `main`: «The MIT License · Copyright (c) 2021-2025 Temporal Technologies Inc.» (`sha256` `434e542427eae407…`) |
| `@temporalio/*@1.24.0` instalados | **MIT** | `"license": "MIT"` en el `package.json` de `worker`, `client`, `workflow`, `activity` y `core-bridge` |
