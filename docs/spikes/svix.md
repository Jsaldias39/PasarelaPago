> Peldaño: DISCOVERED (solo documental; el servidor no se pudo ejecutar) · Veredicto: PARCIAL

# Spike — Svix (webhooks salientes) · P1

Fecha: 2026-10-27 · Servicio afectado: `pay-webhooks` · Criterio de salida: «¿podemos usar el servidor de Svix tal cual?»

## Pregunta

¿Se puede correr `svix/svix-server` desde este entorno, qué necesita para funcionar y bajo qué licencia
se distribuye el servidor (que puede diferir de la de sus SDK)?

## Qué se hizo

```bash
docker pull svix/svix-server:latest
docker pull mirror.gcr.io/svix/svix-server:latest
docker pull mirror.gcr.io/svix/svix-server:v1.38.0     # versión probada como alternativa
curl -s https://raw.githubusercontent.com/svix/svix-webhooks/main/{README.md,server/README.md,LICENSE,server/LICENSE,
     server/svix-server/config.default.toml}
```

## Resultados

### 1. La imagen no se puede ejecutar acá (BLOCKED)

```text
$ docker pull svix/svix-server:latest
Error response from daemon: unknown: failed to resolve reference "docker.io/svix/svix-server:latest":
  unexpected status from HEAD request to https://registry-1.docker.io/v2/svix/svix-server/manifests/latest:
  429 Too Many Requests

$ docker pull mirror.gcr.io/svix/svix-server:latest
failed to copy: httpReadSeeker: failed open: content at
  https://mirror.gcr.io/v2/svix/svix-server/manifests/sha256:4b837dc1... not found

$ docker pull mirror.gcr.io/svix/svix-server:v1.38.0
failed to copy: httpReadSeeker: failed open: could not fetch content descriptor
  sha256:617e54d5... (application/vnd.oci.image.layer.v1.tar+gzip) from remote: not found
```

- Docker Hub directo limita las descargas anónimas (`429`).
- El espejo resuelve el nombre pero **no tiene las capas** de la imagen (`not found`).
- `v1.38.0` fue una versión que probé sin haberla visto listada; el hecho de que el espejo conteste no prueba que esa versión exista como publicación oficial.

Compilar desde el código fuente (el README pide la toolchain de Rust y un compose con Postgres y Redis) **no se
intentó**: en este mismo spike el sistema de permisos denegó compilar y ejecutar código de terceros descargado
(ver `card-vault.md` y `openbao.md`).

### 2. Qué dicen sus propios documentos

- El servidor está escrito en **Rust**; la forma recomendada de correrlo es la imagen oficial de Docker Hub o el `docker-compose.yml` del repo, que «también levanta y configura `redis` y `postgresql`».
- La suite de pruebas del servidor «asume un PostgreSQL y un Redis en ejecución».
- `config.default.toml` trae `queue_type = "redis"` por defecto, con un comentario de que el DSN de la cola «puede quedar vacío si no se usa Redis». **Qué otros tipos de cola existen no lo verifiqué**, así que «Redis opcional» sigue sin confirmarse con fuente primaria.
- El README advierte configurar Redis con `maxmemory-policy noeviction` (o equivalente): con otra política, Redis puede descartar entregas pendientes.
- Svix se integra con el contrato **Standard Webhooks** que ya adopta el plan (cabeceras `webhook-id`, `webhook-timestamp`, `webhook-signature`).

## Veredicto: PARCIAL

- **En el papel:** cubre lo que el carril P1 necesita (firma, reintentos, salud del endpoint) sin escribir un motor propio, y su licencia es permisiva.
- **Sin demostrar:** que corra en nuestro entorno, su comportamiento ante endpoint caído y `410`, el reenvío con el mismo `webhook-id`, y la cola sin Redis.
- Hasta tener la imagen, el carril P1 puede avanzar contra el receptor de prueba y los vectores de `@pay/webhook-signature`, declarando que `pay-webhooks` está construido contra un doble.

## No cubierto

Ejecución del servidor, reintentos, deshabilitación por `410`, rotación de secretos con firmas dobles, rendimiento, modos de cola alternativos a Redis, y qué ocurre con la reentrega cuando Redis evicta claves.

## Licencia verificada

Los dos archivos son **MIT**; no hay una licencia distinta para el servidor:

| Archivo | Texto | URL |
|---|---|---|
| `LICENSE` (raíz de `svix/svix-webhooks`, incluye los SDK) | «The MIT License · Copyright (c) 2021 Svix (https://www.svix.com)» | <https://raw.githubusercontent.com/svix/svix-webhooks/main/LICENSE> |
| `server/LICENSE` (servidor) | Texto de permiso MIT («Permission is hereby granted, free of charge…») · «Copyright (c) 2021-2022 Svix Inc.» (sin el título «The MIT License») | <https://raw.githubusercontent.com/svix/svix-webhooks/main/server/LICENSE> |

Consultadas el 2026-10-27. El `README` del servidor también muestra la insignia `license-MIT`.
