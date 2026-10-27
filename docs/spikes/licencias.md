> Peldaño: DISCOVERED (textos leídos de los archivos `LICENSE` publicados; no es asesoría legal) · Veredicto: PARCIAL (2 alertas)

# Licencias de los proyectos que adopta el plan

Fecha de consulta: **2026-10-27**. Fuente: el archivo de licencia publicado en la rama indicada de cada repo
(`raw.githubusercontent.com`). La licencia se identificó por el **texto** del archivo, no por la etiqueta de
GitHub. TigerBeetle y Temporal los cubre el otro fork (ver sus documentos en esta carpeta).

| Proyecto | Archivo y rama | Licencia (por su texto) | Alerta | URL |
|---|---|---|---|---|
| moov-io/watchman | `LICENSE` · `master` | Apache-2.0 | — | <https://raw.githubusercontent.com/moov-io/watchman/master/LICENSE> |
| juspay/hyperswitch-card-vault | `LICENSE` · `main` | Apache-2.0 | — | <https://raw.githubusercontent.com/juspay/hyperswitch-card-vault/main/LICENSE> |
| svix/svix-webhooks (raíz, SDK) | `LICENSE` · `main` | MIT («The MIT License · Copyright (c) 2021 Svix») | — | <https://raw.githubusercontent.com/svix/svix-webhooks/main/LICENSE> |
| svix/svix-webhooks (servidor) | `server/LICENSE` · `main` | MIT (texto de permiso MIT · «Copyright (c) 2021-2022 Svix Inc.») | — | <https://raw.githubusercontent.com/svix/svix-webhooks/main/server/LICENSE> |
| openbao/openbao | `LICENSE` · `main` | **MPL-2.0** («Mozilla Public License, version 2.0 · Copyright (c) 2015 HashiCorp, Inc.») | ⚠ copyleft a nivel de archivo (ver nota 1) | <https://raw.githubusercontent.com/openbao/openbao/main/LICENSE> |
| nats-io/nats-server | `LICENSE` · `main` | Apache-2.0 | — | <https://raw.githubusercontent.com/nats-io/nats-server/main/LICENSE> |
| nats-io/nats.js | `LICENSE` · `main` | Apache-2.0 | — | <https://raw.githubusercontent.com/nats-io/nats.js/main/LICENSE> |
| debezium/debezium (solo si se adopta; el plan usa el **patrón** y un relé propio con NATS) | `LICENSE.txt` · `main` | Apache-2.0 | — | <https://raw.githubusercontent.com/debezium/debezium/main/LICENSE.txt> |
| blnkfinance/blnk | `LICENSE.md` · `main` | Apache-2.0 (sin el apéndice «How to apply…») | ⚠ ver nota 3 | <https://raw.githubusercontent.com/blnkfinance/blnk/main/LICENSE.md> |
| formancehq/ledger (v3, rama `main`) | **no hay archivo de licencia** en la raíz | **No declarada** | 🔴 ver nota 2 | <https://github.com/formancehq/ledger> |
| formancehq/stack (repo anterior) | `LICENSE` · `main` | MIT **condicionada**, con directorio `ee/` bajo otra licencia | 🔴 ver nota 2 | <https://raw.githubusercontent.com/formancehq/stack/main/LICENSE> |

## Cómo se comprobó

- Watchman, card-vault, nats-server y nats.js tienen **el mismo hash** de archivo (`c71d239d…`, 11.357 bytes): es el texto canónico de Apache-2.0.
- Debezium difiere sólo en un salto de línea inicial y en la falta de salto de línea final (el resto de las líneas coincide con el texto canónico).
- El de Blnk difiere del canónico (la salida de `diff` tiene 15 líneas): le falta el apéndice «APPENDIX: How to apply the Apache License to your work».
- Svix: ambos archivos contienen la frase «Permission is hereby granted, free of charge…» (MIT); el del servidor no lleva el título «The MIT License».

## Alertas

**Nota 1 — OpenBao (MPL-2.0).** No es de las licencias que el plan excluye (AGPL, BSL, SSPL), pero tiene copyleft por archivo:
si modificamos archivos de OpenBao hay que publicar esas modificaciones. Usarlo sin tocarlo, como servicio, no obliga a publicar nuestro código.
Que lo revise legal antes de distribuir una versión modificada.

**Nota 2 — Formance 🔴.**
- `formancehq/ledger` (v3, «Raft Cluster»): `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING` y `licenses/LICENSE` devuelven `404` en `main`, y el README no menciona licencia (búsqueda de «licen» sin resultados). **Sin licencia declarada, por defecto, no se concede permiso de uso.** No se puede adoptar hasta aclararlo con el proyecto.
- `formancehq/stack` (repo anterior): su `LICENSE` dice que lo que está bajo `ee/` es «Enterprise Edition» con otra licencia (`./ee/LICENSE`), y que la «Community Edition» se ofrece bajo MIT **solo si no se usa software de `ee/` y no se tiene una cuenta registrada en su oferta en la nube**. Es MIT con condiciones.
- Consecuencia para el plan: Formance queda **descartado como alternativa de ledger** salvo confirmación escrita de su licencia. (`INVESTIGACION.md` lo marcaba «MIT · confirmada»: **eso estaba incompleto**.)

**Nota 3 — Blnk ⚠.** El archivo es Apache-2.0, pero una fuente de terceros que vio el equipo (no verificada) habla de «licencia dual» con una oferta comercial en la nube. En el `LICENSE.md` no aparece ninguna restricción. No revisé si el repo tiene directorios con otra licencia. Si se llega a adoptar, revisar el árbol completo.

## No cubierto

Licencias de las **dependencias** de cada proyecto (transitivas), directorios con licencia propia dentro de cada repo (salvo lo anotado de Formance), versiones anteriores o posteriores a la consultada, patentes, y marcas. TigerBeetle y Temporal: ver los documentos del otro fork.
