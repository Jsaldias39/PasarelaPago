# pay-qr

Emite y anula códigos QR EMVCo MPM (modo presentado por el comercio) para BOB. Dueño: **P4**. Lo llama `pay-connectors`.
Plan: `docs/plan/PLAN-MAESTRO.md`; carril: `docs/plan/carriles/P4-conectores-ruteo-y-qr.md`.

> **Perfil provisional, no interoperable todavía:** ver [`docs/perfil-qr-bo.md`](docs/perfil-qr-bo.md). No hay perfil boliviano verificable (Q-01, Q-11).

## API (contrato PROPUESTO)

El contrato vive en `contracts/openapi/internal-qr-v1.yaml` (la propuesta de la ola 1 ya se integró; las pruebas leen ese archivo).

| Ruta | Qué hace |
|---|---|
| `POST /qr` | Emite un QR estático (uno vigente por comercio) o dinámico (uno vigente por intento). `Idempotency-Key` obligatoria |
| `GET /qr/{id}` | Consulta. `status` se calcula al leer: un dinámico vencido pasa a `expired` |
| `GET /qr-references/{reference}` | Busca por la referencia del payload (para validar un pago recibido) |
| `GET /qr/{id}/image?format=svg\|png` | Imagen. No se cachea |
| `POST /qr/{id}/cancel` | Anula (idempotente; también anula uno vencido) |
| `POST /qr/decode` | Lee un payload sin guardarlo |

Toda ruta pasa por `ServiceIdentityGuard` (global, denegado por defecto): solo `pay-connectors`. La salud es pública.

## Datos

**El esquema es el del MODELO** (D-18): [`sql/ddl.sql`](sql/ddl.sql) es la copia vendorizada de `mantra-core-health-model/SQL/pay/75_pay_qr/ddl.sql` (con las tablas técnicas incluidas;
no se edita a mano: `scripts/vendor-ddl.sh` y `scripts/vendor-ddl.sh --check`). Deriva (97.2): `src/schema-map.ts` (lo que el código usa; sin ORM, `pg` directo) y `test/drift.spec.ts`, con controles negativos. Sin datos personales: el payload lleva monto, referencia, id y nombre comercial del comercio.

## Configuración

`QR_ACCOUNT_GUID` es obligatorio (lo asigna el banco o el regulador; el de las pruebas es provisional y el del arnés e2e es `e2e.sandbox.guid`). **Bajo `PAY_MODE=live` un GUID provisional, sandbox, e2e o simulado no arranca** (un QR de pruebas no puede salir como real); `PAY_MODE` ausente o mal escrito tampoco. Probado con el binario real en `test/startup.spec.ts`. El resto: ver `.env.example`.

## Pruebas

`yarn test` corre contra Postgres real (esquema aislado por archivo). `src/emv/emv.spec.ts` verifica el CRC con el vector estándar y 12 payloads
publicados por terceros, y que **cambiar un carácter cualquiera de cualquier payload lo invalida** (más de 1.000 mutaciones). `test/qr.spec.ts`
valida cada respuesta contra el contrato propuesto, lee el PNG con un decodificador independiente (`jsQR`) y cubre la matriz negativa de identidad.

## Modo de la clave (`X-Pay-Mode`, D-28)

Toda ruta interna lo exige (`test` o `live`; ausente o inválido ⇒ `403 forbidden` sin efecto) y tiene que coincidir con `PAY_MODE` (`sandbox` ↔ `test`, `live` ↔ `live`; obligatorio, sin valor por defecto). El QR guarda su `pay_mode`; leer, anular o buscar por referencia un QR del otro modo da `404`. La `Idempotency-Key` se guarda por `llamador|modo`, y el QR estático (uno por comercio) y el dinámico (uno por intento) son únicos **por modo**. La referencia del QR es única entre modos porque viaja dentro del código que se escanea.


## `X-Pay-Mode: sandbox` en las respuestas (D-26)

En un despliegue `sandbox` **toda respuesta** (éxitos, errores, `403` del guard, `404`, salud, imágenes) lleva `X-Pay-Mode: sandbox` (`contracts/openapi/common.yaml`, `XPayModeSandbox`); en `live` no se envía. Es la cabecera de la RESPUESTA
(el despliegue); la de la petición (`test|live`) es la del modo de la clave (D-28) y no la cambia. Probado en `test/sandbox-header.spec.ts`. Los spans de OpenTelemetry no guardan la URL cruda (`src/observability/scrub.ts`, regla 90.2).
