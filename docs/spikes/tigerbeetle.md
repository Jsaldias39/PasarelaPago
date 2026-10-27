> Peldaño: TESTED · Veredicto: SÍ (con condiciones, ver §3)

# Spike P2.H1.M1 — ¿Sirve TigerBeetle como motor de `pay-ledger`?

- **Fecha:** 2026-10-27 · **Carril:** P2 · **Microtarea:** P2.H1.M1
- **Versión probada:** servidor `tigerbeetle 0.17.9+cc1c06a` (commit `cc1c06a924e49b11089c521b2209d34c92caaf18`, Zig 0.14.1, binario `x86_64-linux` de los *releases* de GitHub), cliente `tigerbeetle-node@0.17.9`.
- **Entorno:** Linux x86_64, 4 vCPU, réplica de **1 nodo** en loopback. Datos 100 % sintéticos, montos en centavos de BOB.
- **Código y salidas:** [`tigerbeetle/spike.cjs`](./tigerbeetle/spike.cjs) (los experimentos), [`salida-modo-produccion.txt`](./tigerbeetle/salida-modo-produccion.txt) (salida literal), [`sondeo-clientes.cjs`](./tigerbeetle/sondeo-clientes.cjs) y [`salida-sondeo-clientes.txt`](./tigerbeetle/salida-sondeo-clientes.txt), [`recovery.cjs`](./tigerbeetle/recovery.cjs).

## 1 · Cómo se reprodujo

```bash
# binario: https://github.com/tigerbeetle/tigerbeetle/releases/latest/download/tigerbeetle-x86_64-linux.zip
./tigerbeetle format --cluster=0 --replica=0 --replica-count=1 ./0_0.tigerbeetle     # modo producción: sin --development
./tigerbeetle start  --addresses=127.0.0.1:19002 ./0_0.tigerbeetle
cd docs/spikes/tigerbeetle && npm i tigerbeetle-node@0.17.9
TB_ADDR=127.0.0.1:19002 RUN=cc33dd44 node spike.cjs
```

Se probó en dos configuraciones: **desarrollo** (`--development`, puerto 19001) y **producción** (sin ese flag, puerto 19002). Los resultados de las preguntas 2 a 7 salen de la de producción; la de desarrollo se usó para diagnosticar un tope de conexiones (hallazgo H-4).

## 2 · Preguntas y resultados

| # | Pregunta | Qué se hizo | Resultado (salida literal recortada) |
|---|---|---|---|
| 1 | ¿Formatea y arranca una réplica de 1 nodo? | `format` + `start` (arriba) | `formatted: cluster=0 replica_count=1` · `cluster=0: listening on ... port = 19002` · archivo de datos de **1141374976 bytes** (1,06 GiB) reservado de entrada. En modo producción: `Allocated 3086MiB during replica init`, `Grid cache: 1024MiB`. En desarrollo: `1453MiB` y `32MiB`. Aviso del servidor: *«A cluster id of 0 is reserved for testing and benchmarking, do not use in production»*. |
| 2 | ¿Un débito mayor al saldo se rechaza sin cambiar el saldo? | `merchant:A:available` con `debits_must_not_exceed_credits`; fondeo de 5000; débito de 5001 | `E2 ... ["exceeds_credits(54)"]` · saldo antes y después idéntico: `credits_posted 5000, debits_posted 0`. Un débito de 200 después: `created`. |
| 3 | Dos fases: `pending` → `post` / `void` / vencimiento | `pending` 1000; `post`; `pending` 500 + `void`; `pending` 700 con `timeout=2` | Con la retención de 1000: `disponible 3800` (baja de 4800) y gastar 4000 da `exceeds_credits(54)` (**no hay gasto doble sobre lo retenido**). `post` → `created`, `debits_pending` vuelve a 0 y `debits_posted` sube 1000. Segundo `post` sobre lo mismo: `pending_transfer_already_posted(33)`. `void` → el monto vuelve (`disponible 3800`). Con `timeout=2`: `debits_pending 700` y **6 s después** `debits_pending 0`, `disponible 3800`; `post` posterior: `pending_transfer_expired(35)`. |
| 4 | Idempotencia: mismo `id` ×10 en paralelo | 10 llamadas concurrentes con **un** cliente, y 10 **clientes** distintos | `{"created(4294967295)":1,"exists(46)":9}` en los dos casos; delta de saldo **−100** (una sola vez). Mismo `id` con otro monto: `exists_with_different_amount(39)`. Código exacto de «ya existe, mismo contenido»: **`exists` = 46**; para cuentas: **`exists` = 21**. |
| 5 | Lote enlazado (`linked`) atómico | Cadena de 3: dos válidas + una que excede el saldo | `["linked_event_failed(1)","linked_event_failed(1)","exceeds_credits(54)"]` y **delta de saldo 0**: no se aplicó ninguna. Cadena válida de 2: ambas `created`. |
| 6 | IDs de 128 bits derivados de un id lógico; consultas | `sha256("alovida-pay\|<run>\|<id lógico>")` truncado a 16 bytes, con 0 y 2^128−1 reemplazados | Derivación determinista (`igual: true`). `lookupTransfers` de 3 ids devolvió **2** (la rechazada no existe). `getAccountTransfers(AVAIL)` devolvió 11 (las rechazadas no figuran). `getAccountBalances` (cuenta con flag `history`) devolvió el historial de saldos: `cp 5000/dp 0` → `dp 200` → `dpend 1000`. `id = 0` se rechaza: `id_must_not_be_zero(6)`. |
| 7 | Límites | Lotes de 8189/8190/8191 transferencias; cliente con `cluster_id` equivocado; clientes simultáneos | Ver hallazgos H-3, H-4 y H-5. |
| — | ¿Sobrevive el saldo a un `kill -9`? | `kill -9` de la réplica y reinicio sobre el mismo archivo | Antes: `{"debits_posted":"1421","credits_posted":"5000","debits_pending":"0"}`. Después del reinicio (`transition_to_normal_from_recovering_status: view=2 primary`): **idéntico**. |

## 3 · Hallazgos que cambian el diseño de `pay-ledger`

| ID | Hallazgo | Evidencia | Consecuencia para el plan |
|---|---|---|---|
| H-1 | **Un `id` de transferencia rechazada no se puede reintentar.** | E4d: mismo `id` y mismo monto → `id_already_failed(68)`. E4e: mismo `id` con un monto que sí alcanza → `id_already_failed(68)`. E4f: `id` nuevo con ese monto → `created`. | El `id` de la transferencia no puede ser solo el del intento de pago: debe incluir la operación **y el número de intento de ledger**. Un rechazo de negocio (saldo insuficiente) es definitivo para ese `id`. Hay que escribirlo en `internal/ledger/v1/transfers` y en `@pay/idempotency`. No se probó cuánto tiempo recuerda el servidor un `id` fallido ni si lo recuerda tras reiniciar. |
| H-2 | **Las transferencias rechazadas no se guardan.** | `lookupTransfers` devolvió 2 de 3; no aparecen en `getAccountTransfers`. | Si se necesita rastro de los rechazos (auditoría, riesgo), lo escribe `pay-ledger` en su Postgres; TigerBeetle no lo tiene. |
| H-3 | **Tope de lote observado: 8189 transferencias.** | 8189 → 8189 `created`; 8190 y 8191 → `RequestError: Too much data was sent or requested in this batch.` | El servidor declara `message_size_max=1048576`. Mi estimación teórica era 8190 y el real fue 8189: no investigué el porqué (puede haber un campo reservado). Diseñar con un margen y partir lotes. |
| H-4 | **Tope de conexiones de cliente simultáneas: 8 en `--development`, 32 en producción.** | Con `--development`: 10 clientes simultáneos → `ok=8 timeout=2`, también creándolos en secuencia, y el 9.º entra recién cuando otro se cierra (`ms_por_cliente=...,13081,18070`). Sin `--development`: 10 → `ok=10` en 709 ms; 40 → `ok=32 timeout=8`; 64 → `ok=32`; 70 → `ok=32` (límite de espera de mi sondeo: 20 s). El tope es del **servidor**, no del proceso (dos procesos suman contra el mismo tope). | `clients_max=64` de la configuración del clúster no es el tope de conexiones simultáneas. Cada instancia de `pay-ledger` debe usar **un cliente de larga vida**, no uno por petición. E4 mostró que varias llamadas concurrentes sobre un mismo cliente funcionan. No se identificó el parámetro que fija el 8 y el 32 (el binario no expone `--help`). |
| H-5 | **Un `cluster_id` equivocado no da error: no responde.** | E7b: 8 s sin respuesta y sin excepción (el cliente reintenta). | `pay-ledger` debe poner *timeout* propio en cada llamada y validar la configuración al arrancar. |
| H-6 | **Modo desarrollo ≠ producción.** | Memoria reservada y caché distintas (ver fila 1 de §2). El modo producción arrancó en este entorno. | El dimensionado del contenedor tiene que partir de ~3 GiB de memoria **solo para arrancar la réplica**. No se verificó en el VPS de Coolify (sistema de archivos, E/S directa). `--cluster=0` no es para producción: usar otro id. |
| H-7 | **Sin metadatos de negocio.** | Solo `user_data_128/64/32`, `ledger` y `code`. | Se confirma el reparto del plan: TigerBeetle guarda saldos y asientos; a qué factura o comercio corresponde cada cuenta vive en Postgres (`pay_ledger`). El mapeo cuenta lógica → `id` de 128 bits tiene que ser reproducible: sirve el hash truncado de este spike, almacenando el mapeo. |

## 4 · Veredicto

**SÍ sirve para `pay-ledger`, con tres condiciones: modo producción (no `--development`), un cliente de larga vida por instancia, y `id` de transferencia derivado por intento de ledger (H-1).**

Criterio fijado de antemano (REQ-P2-1 a REQ-P2-4 y la pregunta de la microtarea), todos cumplidos en la réplica de 1 nodo:

| Criterio | Cumplido |
|---|---|
| El mismo `id` ×N en paralelo produce un solo efecto (REQ-P2-1) | Sí: 1 `created` + 9 `exists`, delta −100 |
| Un débito sin saldo se rechaza y el saldo no cambia (REQ-P2-2) | Sí: `exceeds_credits(54)` |
| Una retención vence y devuelve el monto (REQ-P2-3) | Sí: `debits_pending 700 → 0` |
| Un lote enlazado es todo o nada | Sí: delta 0 |
| Licencia que permita usarlo en la pasarela | Sí: Apache-2.0 |
| Los saldos confirmados sobreviven a un `kill -9` | Sí: saldos idénticos |

## 5 · No cubierto

No se ejercitó y **no se afirma**:

- **Varias réplicas** (clúster de 3 o 6 nodos), cambios de vista con carga, falla de un nodo, pérdida de disco, restauración desde copia.
- **Rendimiento:** no se midió. El único dato es que un lote de 8189 transferencias se aplicó en una llamada. La carga objetivo (más de 100.000 pagos/día) **no está medida**.
- La precisión del vencimiento: solo se observó que con `timeout=2` la retención ya estaba liberada a los 6 s.
- `id_already_failed` tras un reinicio y su duración (H-1).
- Los *flags* `balancing_*`, `closing_*`, `imported` y `closed`, y las consultas `query_accounts` / `query_transfers`.
- Autenticación o cifrado del puerto de TigerBeetle: no se revisó; hay que asumir que la protección es de red hasta confirmarlo.
- Despliegue en Coolify (volumen persistente, E/S directa, límites de memoria), métricas, actualizaciones entre versiones.
- El caso `kill -9` se hizo con **una** réplica y sin carga concurrente en el momento de la caída.
- Aviso: mientras corrían los experimentos aparecieron mensajes `warning(message_bus): ... error.ConnectionResetByPeer` en el proceso **cliente** (no en el log del servidor) cuando se superaba el tope de conexiones (H-4). Esas líneas se filtraron con `grep -v` al guardar `salida-modo-produccion.txt`; **no se contó** si la corrida de producción las generó.

## 6 · Licencia verificada

| Componente | Licencia | Cómo se verificó |
|---|---|---|
| `tigerbeetle/tigerbeetle` (servidor) | **Apache License 2.0** | `LICENSE` de `main` en `raw.githubusercontent.com`: encabezado «Apache License, Version 2.0, January 2004», 177 líneas, `sha256 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `tigerbeetle-node@0.17.9` (cliente) | **Apache-2.0** | `"license": "Apache-2.0"` en su `package.json` instalado |
