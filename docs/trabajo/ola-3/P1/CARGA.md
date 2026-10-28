# Prueba de carga de T-01: criterio escrito de antemano, runner y cómo correrla

> **Estado: el runner está escrito y probado como instrumento (42 pruebas) y validado con UN humo corto real (`--rps 5 --ramp-seconds 10 --minutes 1`, ver «Humo del instrumento»); la prueba completa NO se ha corrido.** Este documento fija el criterio de aceptación **antes** de la primera corrida (PLAN-MAESTRO §8: «prueba de carga en la ola 3 con criterio escrito de antemano»). Si el criterio cambia después de ver un resultado, el cambio se registra acá con la fecha y la razón, y el resultado anterior se reporta tal cual.
> **Advertencia que manda sobre todo lo demás:** esta máquina de **4 vCPU** (compartida, con Postgres, NATS, Redis, Temporal, TigerBeetle, Watchman y los **12 servicios en el mismo host**) **NO representa el despliegue de producción** (Coolify multiservidor, T-01). El resultado sirve para **encontrar cuellos de botella y errores de concurrencia**, no para **certificar T-01**. Un `APRUEBA` acá no demuestra que producción aguante 2 × 100.000 pagos por día; un `NO APRUEBA` acá puede deberse al hardware de prueba. El informe lo repite en cada corrida.

## 1 · Qué se quiere saber (T-01)

D-14: más de 100.000 pagos por día el primer año. D-09: despliegue en Coolify. **T-01**: un solo VPS no alcanza para eso con 11 servicios, Temporal, TigerBeetle y NATS; la mitigación es repartir en varios servidores y una **prueba de carga a 2 × el volumen objetivo**, con criterio escrito de antemano; si no alcanza con Coolify multiservidor se vuelve a decidir el despliegue (Kubernetes) antes de producción.

| Dato | Valor | Origen |
|---|---|---|
| Volumen objetivo | 100.000 pagos/día | D-14 |
| Volumen de la prueba | 2 × = **200.000 pagos/día** | T-01 |
| Promedio de 200.000/día | ≈ 2,3 pagos/s | aritmética |
| **Pico asumido** | **25 pagos/s** (≈ 10 × el promedio) | **SUPUESTO del integrador, no un dato del dueño**: la distribución horaria real de los pagos no está definida. Se pide confirmarla; el runner lo recibe como parámetro (`--rps`). |
| Un pago de la prueba | un intento QR de Bs 100,00 (`amount_minor: 10000`, escenario «aprobado» de `pay-mockbank`) | `docs/trabajo/ola-2/P4/ESCENARIOS.md` |

A 25 rps sostenidos durante 5 minutos son ≈ 7.500 intentos; un día a ese pico serían 2.160.000: la prueba **no** pretende reproducir un día, sino exponer la mecánica bajo un pico y la rampa.

## 2 · Criterio de aceptación (escrito antes de correr)

Los cuatro tienen que cumplirse **a la vez**, en una corrida **sin reservas** (ver §4):

| # | Criterio | Cómo se mide | Objetivo |
|---|---|---|---|
| 1 | **Latencia** | p99 del tiempo de respuesta de `POST /v1/payment_intents` (desde que sale el pedido hasta que termina la respuesta), todas las claves juntas | **< 2 s** (estricto: 2.000 ms no pasa) |
| 2 | **Errores del servidor** | respuestas 5xx ÷ pedidos que recibieron respuesta | **< 0,1 %** (estricto) |
| 3 | **Ningún intento colgado** | intentos creados que, tras la fase de envío, no llegan a un estado terminal (`succeeded`, `failed`, `canceled`, `expired`) dentro de **120 s** de espera por condición (se consulta cada intento con `GET /v1/payment_intents/{id}` hasta el plazo) | **0** (un intento en `processing`/`requires_action` pasado el plazo es un defecto, no un fallo ambiguo: el hallazgo 9 de `ARNES.md` es exactamente esto) |
| 4 | **Ningún doble asiento** | (a) en el ledger REAL, por cada intento `succeeded`, líneas de crédito `business_ref = <pi>:capture` sobre `merchant:<id>:pending` (debe haber **exactamente una**); (b) claves de idempotencia repetidas a propósito que devolvieron un intento distinto | **0** duplicados y **0** violaciones |

Reglas de lectura que también se fijan ahora:
- **Un `429` no es un 5xx ni un acierto**: el frenado por clave/IP del borde actuó y parte de la carga no llegó a los servicios. Se cuenta aparte y hace la corrida **NO CONCLUYENTE**. Para medir los servicios, la corrida se hace con los topes del borde levantados (`RATE_LIMIT_IP_PER_WINDOW`/`RATE_LIMIT_KEY_PER_WINDOW`, parametrizados en `compose.mock.yml`: por defecto 300 y 600 por minuto, es decir ≈ 5 y 10 rps); el frenado en sí se evalúa por separado (ya lo cubre `authz.spec.ts`).
- **Un pedido sin respuesta (corte, plazo vencido) es AMBIGUO** (CLAUDE.md regla 11): no entra al porcentaje de 5xx, se informa aparte y no se da por fallo ni por éxito.
- **Lo que no se mide no es verde**: sin lectura del ledger, o sin ninguna respuesta, el veredicto es `NO CONCLUYENTE`.
- Un criterio que **falla** vale aunque haya reservas (la falla ocurrió igual); un criterio que pasa con reservas **no certifica nada**.

Veredictos: **APRUEBA** (los 4 pasan y no hay reservas) · **NO APRUEBA** (alguno falla) · **NO CONCLUYENTE** (nada falla pero hay reservas o algo sin medir). Código de salida de `yarn load`: 0 / 1 / 3.

## 3 · Qué más se mide (informativo, no es criterio)

p50/p95 de la creación; tasa real enviada y **retraso de salida del generador** (si crece, el cuello es el generador y no el sistema); estados HTTP y códigos de error del contrato; tiempo hasta el estado terminal (p50/p95/p99); intentos `failed` por código (`risk_denied`, `payment_declined`, `risk_unavailable`…); y la **saturación**: CPU de cada proceso o contenedor (media y máximo, 100 % = un núcleo), CPU de toda la máquina y carga del sistema. La saturación es lo que dice si un resultado habla del diseño o del hardware.

## 4 · Reservas que vuelven NO CONCLUYENTE una corrida
`429` presentes · el generador descartó pedidos por llegar a su tope de pedidos en vuelo · el generador se atrasó (p99 de retraso de salida > 100 ms) · hubo intentos `succeeded` sin asiento al leer el ledger (puede ser demora: repetir la lectura) · la CPU media de la máquina superó 90 % (el resultado mide esta máquina) · faltó medir algo.

## 5 · El runner (`e2e/load/`, Node puro, sin dependencias nuevas)

- **Generador abierto con rampa**: las peticiones salen en los instantes planificados, no cuando termina la anterior (un generador cerrado dejaría de cargar justo cuando el sistema se enlentece: «omisión coordinada»). Tasa lineal desde 0 hasta el pico en la rampa y constante después (`plan.ts`).
- **API pública de `pay-edge` con claves `sk_test_`** (se niega a usar una `sk_live_` y a cargar un destino que no sea de esta máquina sin `--allow-remote`). Las claves salen de la siembra (`yarn seed:sandbox` → `platform/.sandbox/seed-state.json`); los pedidos se reparten en turnos entre ellas.
- **`Idempotency-Key` únicas** por pedido (`load-<corrida>-<n>`) y, por defecto, el **2 %** de los pedidos se repite en paralelo con la MISMA clave: deben devolver el MISMO intento (si no, `idempotencyViolations`).
- **Espera por condición** a los estados terminales (consulta por intento, concurrencia 25, plazo 120 s). Nada de pausas ciegas.
- **Ledger**: lee `GET /statements?account=merchant:<id>:pending` de `pay-ledger` (puerto 3105, identidad de servicio de solo lectura, solo desde el inicio de la corrida) y cuenta crédito de captura por intento.
- **Informe**: `report.json` (sin claves) y `resumen.txt` en `docs/trabajo/ola-3/P1/evidencia/carga-<corrida>/`.
- Probado como instrumento (`e2e/load/load.spec.ts`, 41 pruebas sin carga real): percentiles, plan de llegadas, el criterio en sus límites (2.000 ms, 0,1 % exacto), el conteo de asientos duplicados/faltantes, los lectores de CPU, y el runner contra un borde falso al que se le inyectan 5xx, 429, plazos vencidos, intentos que nunca terminan e idempotencia rota: cada falla se **detecta**.

## 6 · Cómo se corre (cuando el coordinador lo autorice; hoy NO se corrió)

Requisitos: **máquina quieta** (sin otras suites), ≥ 8 GB de disco libre y la capa sandbox arriba. Un stack a la vez.

```bash
# 1. Capa sandbox (ver el encabezado de platform/compose.mock.yml). Topes del borde levantados para medir los servicios, no el frenado:
node platform/scripts/sandbox-secrets.mjs
RATE_LIMIT_IP_PER_WINDOW=1000000 RATE_LIMIT_KEY_PER_WINDOW=1000000 \
  docker compose --env-file platform/.sandbox/secrets.env -f platform/compose.yml -f platform/compose.mock.yml up -d --build --wait
yarn seed:sandbox                                   # 3 comercios con sk_test_ (idempotente)
# 2. Calentar y medir (pico asumido 25 rps; rampa de 60 s; 5 minutos)
yarn load --rps 25 --ramp-seconds 60 --minutes 5
# 3. Variantes para encontrar el techo (ver el cuello en «Procesos con más CPU»): --rps 50, 100; o --minutes 30 para ver degradación lenta
```

**Con el arnés en procesos locales (sin Compose): `yarn load:harness`** — en UN solo proceso toma el candado, levanta `startStack({ mockbank: true })` (12 servicios reales, TigerBeetle propio, calentamiento de pay-risk), sube los topes de tasa del borde SOLO para esa corrida, siembra N comercios con `seedMerchant` (`--merchants`, por defecto 3) y comprueba cada uno con un cobro real hasta `succeeded`, lanza el runner contra el puerto real de pay-edge y el ledger real, muestrea la CPU de los procesos del stack, apaga el stack SIEMPRE (finally y SIGINT/SIGTERM) y sale con 0/1/3 (2 si no pudo prepararse). Mismos parámetros que `yarn load`:

```bash
yarn load:harness --rps 25 --ramp-seconds 60 --minutes 5     # la corrida de T-01 con el arnés (máquina quieta)
yarn load:harness --rps 5 --ramp-seconds 10 --minutes 1       # humo corto para validar el instrumento
yarn load:harness ... --prod-timeouts                         # quita los ajustes de ENTORNO del arnés (RISK_TIMEOUT_MS 2000→300, SCREENING_TIMEOUT_MS 250→200)
```

`yarn load` (sin `harness`) es para un stack que ya está arriba con puertos fijos (Compose); `--cpu auto` usa los PID de `e2e/.run/state.json` o los contenedores `pay-pay-*`. **Ojo:** el arnés usa por defecto `RISK_TIMEOUT_MS=2000` y `SCREENING_TIMEOUT_MS=250` (ajustes de entorno declarados en ARNES.md); con `--prod-timeouts` corre con los valores operativos y es la variante que puede destapar los hallazgos 9 y 10.

**Lo esperable antes de correr (para no sorprenderse; no es un resultado):** con los valores por defecto del compose (`RISK_TIMEOUT_MS=300`, `SCREENING_TIMEOUT_MS=200`), una evaluación de riesgo lenta bajo carga dispara los hallazgos 9 y 10 de `ARNES.md` (intentos que quedan en `processing` para siempre, o `risk_denied` de un comercio limpio). El criterio 3 los va a ver. No se suben esos tiempos para que pase: si aparecen, son el hallazgo.

## 7 · Qué NO responde esta prueba
Capacidad multiservidor; latencia de red real entre servicios; TigerBeetle en clúster (acá es de un nodo); Postgres gestionado; el banco real (el simulado responde en milisegundos y de forma determinista); colas de Temporal con miles de flujos concurrentes en producción; una distribución horaria real. Cuando exista el entorno de staging en Coolify multiservidor, **este mismo runner** apunta a él con `--base … --allow-remote` (solo sandbox/`test`) y el criterio de §2 se mide ahí.

## 8 · Humo del instrumento (no es la prueba de T-01)
`yarn load:harness --rps 5 --ramp-seconds 10 --minutes 1` (2026-10-28, máquina quieta, load ≈ 0,6 al empezar): 283 pedidos enviados (275 planificados + 8 repetidos con la misma clave), 201×283, p50 341 ms / p95 546 ms / p99 643 ms, 275 intentos `succeeded`, 0 colgados, ledger real: 275 asientos de captura, 0 duplicados, 0 faltantes, 0 importes distintos; tiempo hasta terminal p50 1,1 s; veredicto `APRUEBA`; apagado limpio (`leftoverPids: []`, sin procesos ni candado). Salida literal: `evidencia/carga-humo-harness.txt` (+ `carga-humo-harness/report.json`, `resumen.txt`).
**Lo que el humo ya enseña sobre la corrida completa:** con solo 5 rps la CPU de la máquina estuvo en 68 % de media (77 % de máximo), con `pay-payments` (≈ 41 % de un núcleo) como proceso más pesado. Extrapolación SIN medir (solo un orden de magnitud): a 25 rps la máquina se acercará o superará el 90 % y la corrida saldrá `NO CONCLUYENTE` por saturación del hardware de prueba; para el techo real hace falta el entorno multiservidor (§7). La primera versión del runner sondeaba los estados terminales recién al terminar el envío e inflaba el «tiempo hasta terminal» (p50 27,9 s); se corrigió para sondear en paralelo (p50 1,1 s) y hay una prueba que lo exige.
