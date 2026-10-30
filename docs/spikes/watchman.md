> Peldaño: TESTED (mecánica de la API y latencia, con datos congelados de 2019) · BLOCKED (carga de listas vigentes) · Veredicto: PARCIAL

# Spike — moov Watchman (cribado de sanciones) · P5.H2.M1

Fecha: 2026-10-27 · Servicio afectado: `pay-risk` · Criterio de salida: «¿sirve para cribar pagadores y comercios?»

## Pregunta

¿Watchman arranca, qué API expone, puede cargar las listas de sanciones desde este entorno y qué
latencia y comportamiento tiene la búsqueda por nombre?

## Qué se hizo

```bash
docker run -d --name spikeb-watchman  -p 19100:8084 mirror.gcr.io/moov/watchman:latest      # prueba 1
docker run -d --name spikeb-watchman2 -p 19100:8084 -e INCLUDED_LISTS=us_ofac \
           mirror.gcr.io/moov/watchman:v2-static                                               # prueba 2
python3 bench.py   # 50 búsquedas por caso (+1 de calentamiento), un solo cliente, secuencial
```

## Resultados

### 1. La imagen `latest` del espejo es vieja y no arranca sin red (BLOCKED)

`mirror.gcr.io/moov/watchman:latest` es la **v0.31.3**. Al arrancar intenta bajar las listas y falla:

```text
msg="Starting watchman server version v0.31.3"
msg="err while doing client request: ... Get \"https://www.treasury.gov/ofac/downloads/sdn.csv\":
     dial tcp: lookup www.treasury.gov on 8.8.8.8:53: no such host"
msg="ERROR: failed to download/parse initial data: OFAC: no OFAC Results
     DPL: DPL file is empty or missing
     EUCSL: EU CSL file is empty or missing
     UKCSL: uk CSL file is empty or missing
     US CSL: CSL file is empty or missing"
exit=1 status=exited
```

Causa exacta: dentro del contenedor el DNS no resuelve `treasury.gov`, `bis.doc.gov`,
`webgate.ec.europa.eu` ni `ofsistorage.blob.core.windows.net`. Desde el host, `curl` a esas cuatro
URLs devuelve código `000` (el proxy de salida del entorno no las deja pasar); `raw.githubusercontent.com` sí
responde `200`. **Las listas vigentes no se pudieron cargar y no se inventó ninguna.**

El proceso termina con código 1 si no puede cargar datos iniciales: en producción, una caída del
origen de las listas al reiniciar deja a `pay-risk` sin cribado (ver «Qué implica para `pay-risk`»).

### 2. `moov/watchman:v2-static` sí arranca (TESTED, datos de 2019)

El README oficial documenta `moov/watchman:v2-static` como imagen con *«frozen 2019 files for fast local
tests (not the live SDN)»*. Es la única forma de probar la API acá.

```text
msg="Starting watchman server" version=v0.58.1
msg="starting list refresh of [us_ofac]" initial_data_directory=/data/static
GET /v2/listinfo -> {"lists":{"us_ofac":7379},"listHashes":{"us_ofac":"1685b819..."},
  "startedAt":"2026-10-27T14:56:40.938Z","endedAt":"2026-10-27T14:56:44.500Z","version":"v0.58.1"}
```

- Versión **v0.58.1**, 7.379 registros de `us_ofac` indexados en memoria, ~3,6 s de carga.
- **Puertos:** API de negocio `:8084` (sin autenticación, «by design» según su README) y administración `:9094` aparte.
- **Endpoints usados:** `GET /v2/search?type=<person|business|...>&name=…&minMatch=…&limit=…` y `GET /v2/listinfo`.
  El README indica enviar siempre `type`; sin `type` la petición devolvió `HTTP 200` con una consulta vacía (no es un error).
- Cada resultado trae `name`, `entityType`, `sourceList`, `sourceID`, `match` (puntaje 0–1) y `sanctionsInfo`.

### 3. Latencia y comportamiento (50 búsquedas por caso, 1 cliente secuencial, 4 vCPU, 7.379 registros)

| Caso | p50 | p99 | máx. | Resultados con `minMatch=0.80` |
|---|---|---|---|---|
| Nombre exacto de una organización de la lista OFAC (`Hizballah`) | 11,3 ms | 21,1 ms | 24,6 ms | 1 (`HIZBALLAH`, puntaje **0,812**) |
| Nombre aproximado con un error (`Hizbolla`) | 10,3 ms | 18,3 ms | 19,0 ms | **0** |
| Nombre sintético sin relación (`Zyxwvut Qwerty Holdings SRL`) | 17,6 ms | 29,7 ms | 31,5 ms | 0 |
| Igual que el anterior con `minMatch=0.0` (devuelve el ranking) | 14,7 ms | 21,8 ms | 30,5 ms | 3 (puntajes 0,371 y 0,368) |

Puntaje del nombre aproximado `Hizbolla` según el umbral: `minMatch=0.5` → `HIZBALLAH 0.602` y
`ANSAR-E HEZBOLLAH 0.588`; `0.6` → `HIZBALLAH 0.602`; `0.7` y `0.8` → ninguno.

Lectura de los datos (sin extrapolar):

- La búsqueda local es rápida: p99 < 30 ms en esta máquina y con esta lista. **No es una medición de carga**: un cliente, una lista, sin red entre servicios.
- **Una coincidencia exacta de nombre puntuó solo 0,812** y un error de una letra cayó a 0,602. Con el umbral que el propio README llama habitual (0.80), el margen sobre una coincidencia exacta es de 0,012 y el nombre con error no se detecta. El umbral es una decisión de cumplimiento, no un valor por defecto: **no hay umbral recomendado en este spike**.
- Con `minMatch=0` siempre devuelve un ranking aunque nada se parezca (puntajes ~0,37): `pay-risk` tiene que decidir por umbral, nunca por «hubo resultados».

## Veredicto: PARCIAL

- **Sí:** la API es simple, rápida y apta para llamarla de forma síncrona con el *timeout* de 300 ms que fija el carril P5 (p99 observado < 30 ms localmente).
- **No demostrado:** que pueda cargar las listas **vigentes** desde donde se despliegue. Acá fue imposible por la red.
- **Condición para `pay-risk`:** cargar las listas por `file://` o por `*_DOWNLOAD_TEMPLATE` desde un caché propio (el README cita `watchman-cache` y `INITIAL_DATA_DIRECTORY`), de modo que reiniciar no dependa de que el gobierno responda. **Esto no se probó.**
- Watchman cae a salida 1 sin datos: la política del doble en P5 («Watchman caído → `review`, nunca `allow`») sigue siendo la correcta.

## Qué implica para `pay-risk` (decisiones que quedan para el carril, no tomadas acá)

1. Watchman va en red interna: su API no autentica.
2. Umbrales (`deny`/`review`) y qué campos se envían (solo nombre y tipo; los documentos exigen revisar protección de datos) los fija cumplimiento.
3. El README anuncia listas de EE. UU. (OFAC, BIS), UE, Reino Unido y ONU. **No vi mencionadas listas bolivianas**: confirmar con cumplimiento si se exigen.

## No cubierto

- Listas vigentes (OFAC, UE, UK, ONU): no cargadas. Los puntajes de arriba son sobre datos de 2019 y sirven solo para la mecánica.
- Latencia bajo concurrencia, consumo de memoria con la lista completa, refresco periódico (12 h por defecto) y fallo de un refresco.
- Carga desde `file://` o desde `watchman-cache`.
- Búsqueda de personas físicas (`type=person`) con fecha de nacimiento y documento.
- Imagen `latest` de un registro distinto del espejo (el espejo trae una versión vieja).

## Licencia verificada

**Apache-2.0**, texto completo del `LICENSE` de `moov-io/watchman` (rama `master`), idéntico byte a byte al texto canónico que usan NATS y card-vault (hash `c71d239d…`).
URL: <https://raw.githubusercontent.com/moov-io/watchman/master/LICENSE> · consultada 2026-10-27.

## Limpieza

Contenedores `spikeb-watchman` y `spikeb-watchman2` eliminados (`docker ps -a --filter name=spikeb-` → 0).
