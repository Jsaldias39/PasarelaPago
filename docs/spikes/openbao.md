> Peldaño: DISCOVERED (release descargado y verificado por checksum; **no se ejecutó**) · Veredicto: PARCIAL

# Spike — OpenBao (secretos y KMS) · seguridad de la plataforma

Fecha: 2026-10-27 · Servicios afectados: `pay-connectors` (credenciales), `pay-vault` (claves), `platform/` · Criterio de salida: «¿podemos correrlo y guardar/leer un secreto?»

## Pregunta

¿Hay un binario de release de OpenBao que corra en este entorno en modo `-dev` y permita escribir y leer
un secreto KV? ¿Qué versión y qué licencia tiene?

## Qué se hizo

```bash
docker pull mirror.gcr.io/openbao/openbao:latest
docker pull mirror.gcr.io/openbao/openbao:2.1
docker pull ghcr.io/openbao/openbao:latest ; docker pull quay.io/openbao/openbao:latest
curl -sL https://github.com/openbao/openbao/releases/download/v2.7.2/checksums.txt
curl -sL https://github.com/openbao/openbao/releases/download/v2.7.2/openbao_2.7.2_linux_amd64.tar.gz
sha256sum openbao_2.7.2_linux_amd64.tar.gz
```

## Resultados

### 1. Imágenes de contenedor: ninguna se pudo bajar (BLOCKED)

```text
mirror.gcr.io/openbao/openbao:latest -> failed to copy: httpReadSeeker: failed open:
                                        could not fetch content descriptor sha256:805f6cd9...
mirror.gcr.io/openbao/openbao:2.1    -> unknown: failed to resolve reference ... unexpected status (el mensaje se cortó; no se sabe si el tag existe)
ghcr.io/openbao/openbao:latest       -> failed to copy: ... pkg-containers.githubusercontent.com/... (capas)
quay.io/openbao/openbao:latest       -> failed to resolve reference ... failed to do request: Head ...
```

### 2. Binario de release: descargado y verificado, no ejecutado

- Última versión publicada según la página de *releases*: **v2.7.2** (la página muestra «26 Oct» sin año).
- El nombre del asset **no** fue el que suponía (`bao_…`): salió de `checksums.txt` (67 líneas) y es `openbao_2.7.2_linux_amd64.tar.gz`.
- Tamaño 74.907.645 bytes. SHA-256 calculado = SHA-256 de `checksums.txt`:

```text
got  582b1f3c2fdc5afd443b2d57a225ef654de75adea609fdb66731fd582a9cbc96
want 582b1f3c2fdc5afd443b2d57a225ef654de75adea609fdb66731fd582a9cbc96   -> COINCIDE
```

  Ambos archivos vienen del mismo origen (GitHub Releases): esto prueba que la descarga llegó íntegra, **no su autenticidad** (no verifiqué firmas; el release publica archivos `.sbom.json`).
- Contenido del paquete: `bao`, `LICENSE`, `README.md`, `CHANGELOG.md`.

### 3. Ejecución en modo `-dev`: denegada, no se intentó otra vía

El comando que extraía y arrancaba `bao server -dev` fue **denegado por el sistema de permisos** del entorno
(motivo «Code from External»: ejecutar un binario descargado). No se reintentó ni se buscó un rodeo.
Se verificó después que no quedó ningún proceso `bao` (`pgrep -c bao` → `0`) y se borró el archivo descargado.

**No hay, por lo tanto, evidencia de que escriba y lea un secreto KV.** Falta ese experimento mínimo
(`bao kv put` / `bao kv get` contra un servidor `-dev` en `127.0.0.1`).

## Veredicto: PARCIAL

- **Hecho:** existe un release oficial reciente, con checksum y SBOM, y licencia verificada.
- **Pendiente de demostrar:** que arranque, el ciclo KV, y que `hyperswitch-card-vault` lo acepte como respaldo de claves. El card-vault enlaza el cliente `vaultrs` de HashiCorp Vault y no menciona OpenBao: la compatibilidad es una hipótesis.
- Para destrabarlo hace falta permiso para ejecutar el binario (o acceso a una imagen) en un entorno de prueba.

## No cubierto

Arranque, KV v2, políticas, *unseal* y almacenamiento persistente (el modo `-dev` es en memoria y no sirve para producción), cifrado como servicio, auditoría, verificación de firmas del release, compatibilidad con `vaultrs`.

## Licencia verificada

**MPL-2.0** (Mozilla Public License, version 2.0). El `LICENSE` de `openbao/openbao` abre con «Copyright (c) 2015 HashiCorp, Inc. · Mozilla Public License, version 2.0».
URL: <https://raw.githubusercontent.com/openbao/openbao/main/LICENSE> · consultada 2026-10-27.

⚠ Copyleft **a nivel de archivo**: usarlo sin modificarlo como servicio no obliga a publicar nuestro código; modificar archivos de OpenBao sí obliga a publicar esas modificaciones. No es una licencia de las que el plan descarta (AGPL, BSL, SSPL), pero conviene que legal la vea.
