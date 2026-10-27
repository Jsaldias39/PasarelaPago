# pay-qr

Emite y anula códigos QR EMVCo MPM (modo presentado por el comercio) para BOB. Dueño: **P4**. Lo llama `pay-connectors`.
Plan: `docs/plan/PLAN-MAESTRO.md`; carril: `docs/plan/carriles/P4-conectores-ruteo-y-qr.md`.

> **Perfil provisional, no interoperable todavía:** ver [`docs/perfil-qr-bo.md`](docs/perfil-qr-bo.md). No hay perfil boliviano verificable (Q-01, Q-11).

## API (contrato PROPUESTO)

El contrato vive en `docs/trabajo/ola-1/P4/propuesta/internal-qr-v1.yaml` (P4 no puede editar `contracts/`; la integración lo mueve).

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

SQL de referencia, a mover a `mantra-core-health-model` (D-18): [`sql/001_qr_codes.sql`](sql/001_qr_codes.sql), más la tabla técnica de idempotencia
(`contracts/packages/idempotency/sql/001_idempotency_keys.sql`). Sin datos personales: el payload lleva monto, referencia, id y nombre comercial del comercio.

## Configuración

`QR_ACCOUNT_GUID` es obligatorio (lo asigna el banco o el regulador; el de las pruebas es provisional). El resto: ver `.env.example`.

## Pruebas

`yarn test` corre contra Postgres real (esquema aislado por archivo). `src/emv/emv.spec.ts` verifica el CRC con el vector estándar y 12 payloads
publicados por terceros, y que **cambiar un carácter cualquiera de cualquier payload lo invalida** (más de 1.000 mutaciones). `test/qr.spec.ts`
valida cada respuesta contra el contrato propuesto, lee el PNG con un decodificador independiente (`jsQR`) y cubre la matriz negativa de identidad.
