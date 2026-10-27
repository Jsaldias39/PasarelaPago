> Peldaño: DISCOVERED (solo documental; no se ejecutó ni se compiló) · Veredicto: PARCIAL

# Spike — hyperswitch-card-vault (bóveda de tarjetas) · P3.H3.M1

Fecha: 2026-10-27 · Servicio afectado: `pay-vault` · Criterio de salida: «¿encaja como bóveda de PAN de `pay-vault`?»

## Pregunta

¿Se puede desplegar `juspay/hyperswitch-card-vault`, qué API tiene, cómo maneja las claves (¿admite
OpenBao o un KMS?), si los tokens son por comercio y cuál es su licencia?

## Qué se hizo

```bash
docker pull ghcr.io/juspay/hyperswitch-card-vault:latest
curl -s https://raw.githubusercontent.com/juspay/hyperswitch-card-vault/main/{README.md,docs/guides/setup.md,
     src/routes/data.rs,src/routes/data/types.rs,config/development.toml,Cargo.toml,Dockerfile,CHANGELOG.md,LICENSE}
```

Más una consulta a la página pública del repo. Fuentes leídas: README, guía de setup, `routes/data.rs`,
`routes/data/types.rs`, `Cargo.toml`, `Dockerfile`, `config/development.toml` y `CHANGELOG.md`.

## Resultados

### 1. La imagen no se puede bajar desde este entorno (BLOCKED)

```text
$ docker pull ghcr.io/juspay/hyperswitch-card-vault:latest
Error response from daemon: error from registry: denied
denied
```

### 2. Compilarla desde el código fuente: intentado, no se ejecutó

Hay toolchain (`cargo 1.97.0`), pero el sistema de permisos del entorno **denegó** el intento (clonar el repo de
terceros y ejecutar `cargo build --release --bin locker`), con el motivo «Code from External». No se
reintentó ni se buscó un rodeo. Antes, la descarga del tarball por `codeload.github.com` había devuelto `403`.
**El peldaño de este spike es `DISCOVERED`: nada de lo que sigue se vio funcionando.**

### 3. Qué dice el repositorio

**Estado del proyecto.** Lenguaje Rust; la página del repo muestra 230 commits y la sección *Releases* vacía
(no hay versiones publicadas en GitHub). `CHANGELOG.md` lista `0.9.0 (2026-07-31)`, `0.8.0 (2026-06-24)`,
`0.7.0 (2026-02-24)` y `0.6.5 (2025-04-23)`. El `Dockerfile` compila con `rust:slim-trixie`, corre sobre
`debian:trixie-slim` y expone el puerto `8080`.

**API** (de `src/routes/data.rs`; el README dice «API Reference to be linked», **no hay OpenAPI**):

| Operación | Ruta en el código | Petición | Respuesta |
|---|---|---|---|
| Guardar | `POST /add` | `merchant_id`, `merchant_customer_id`, `requestor_card_reference?`, `data`, `ttl` | `status`, `payload{card_reference, duplication_check?, dedup?}` |
| Leer | `POST /retrieve` | `merchant_id`, `merchant_customer_id`, `card_reference` | `status`, `payload{card?, enc_card_data?}` |
| Borrar | `POST /delete` (el README dice «CRD»; en el código es `POST`, con limitador de tasa opcional) | las mismas tres claves | `status` |
| Huella | `POST /fingerprint` | `data?`, `key?`, `batch_data?[{label,data,key}]` | huella(s) |

El README ubica estas rutas bajo `/data`; **no verifiqué el anidamiento** en el archivo del enrutador.
`Card` incluye `card_number`, `name_on_card`, `card_exp_month`, `card_exp_year`, `card_brand`, `card_isin`, `nick_name`.

**Modelo de tokens.** El «token» es `card_reference`, y se guarda **por la combinación `merchant_id` +
`merchant_customer_id`**; el código crea/busca una *entidad* por `merchant_id` (`find_or_create_entity`) y
todas las lecturas filtran por esas dos claves. Tiene `ttl`: al leer, el código compara la fecha con el vencimiento y registra métricas de dato vencido y de
borrado por TTL (no leí la rutina de borrado completa). El README menciona chequeos de hash interno para no duplicar. → Es consistente con P3.H3.M2 («un token de otro comercio no se
puede usar»), **pero esa propiedad no se probó**.

**Gestión de claves** (de `docs/guides/setup.md` y `Cargo.toml`):

- *Master key* AES, cifrada por dos *custodian keys* en manos de dos custodios (`key_custodian`).
- *Middleware* JWE + JWS con dos pares RSA (locker y tenant) que firma y cifra todo el tráfico (`middleware`).
- Respaldo de claves con **AWS KMS** (`kms-aws`), **HashiCorp Vault** vía el crate `vaultrs` (`kms-hashicorp-vault`),
  **GCP KMS** (`kms-gcp`) y un **gestor de claves externo por HTTP** (`external_key_manager`, que en
  `config/development.toml` viene `mode = "disabled"`).
- OpenBao: **el repo no lo menciona.** OpenBao es una bifurcación de Vault y declara compatibilidad de API, pero
  esa compatibilidad **con este cliente no se probó** (hipótesis, no hecho).
- `config/development.toml` incluye una *master key* de ejemplo en claro: es un valor de desarrollo y no se debe reutilizar.

**Despliegue.** Docker; PostgreSQL con migraciones `diesel` (la guía usa `diesel_cli` y crea un usuario con
`SUPERUSER`: para nosotros hay que acotarlo); Redis opcional (`redis`/`kv`); configuración por TOML o por
variables `LOCKER__SECCIÓN__CLAVE`. El `Dockerfile` construye con la bandera `release`, que activa los cuatro
mecanismos de claves de arriba.

**Declaración de PCI.** El README afirma «secure encryption algorithms to be fully compliant with PCI DSS
requirements». Es una afirmación del proyecto, **no una certificación de nuestro despliegue**: el alcance PCI
sigue siendo nuestro (QSA).

## Veredicto: PARCIAL

- **Encaja en el papel:** bóveda separada, token por comercio, TTL, deduplicación, claves con custodios y respaldo en KMS/Vault, tráfico firmado y cifrado, licencia permisiva.
- **Riesgos que aparecen:** sin OpenAPI ni *releases* publicados (hay que fijar por commit), imagen de ghcr no accesible desde acá, `/delete` por `POST`, y un setup que asume un usuario de base con `SUPERUSER`.
- **Para pasar a TESTED hace falta:** un entorno con acceso a ghcr o a un compilador autorizado, y probar: guardar/leer/borrar, aislamiento entre comercios, TTL, huella, rotación de la *master key* y compatibilidad con OpenBao.

## No cubierto

Compilación, ejecución, rendimiento, migraciones, rotación de claves, compatibilidad con OpenBao, anidamiento exacto de rutas, ausencia de PAN en logs, y toda evidencia para PCI.

## Licencia verificada

**Apache-2.0**: texto completo del `LICENSE` de `juspay/hyperswitch-card-vault` (rama `main`), idéntico al
texto canónico de NATS y Watchman (hash `c71d239d…`).
URL: <https://raw.githubusercontent.com/juspay/hyperswitch-card-vault/main/LICENSE> · consultada 2026-10-27.
