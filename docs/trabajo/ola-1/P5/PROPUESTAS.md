# Propuestas de contrato del carril P5 (ola 1)

Cambios que P5 necesita en `contracts/` o en librerías de otros carriles. **No se aplicaron**: cada una espera la
aprobación de su dueño. Quien integra las mueve; hasta entonces las pruebas de P5 usan las propuestas de esta carpeta.

| ID | Propuesta | Dueño que aprueba | Estado |
|---|---|---|---|
| PR-01 | Mover `propuestas/internal-merchants-v1.yaml` a `contracts/openapi/` (cambiar los `$ref` a `common.yaml#/…`). Back-office de `pay-merchants`: 13 operaciones, validadas con Redocly. | integrador | abierta |
| PR-02 | `POST /api_keys` y `POST /api_keys/{id}/rotate`: la repetición con la misma `Idempotency-Key` devuelve **200 sin el secreto** (hoy el contrato solo declara 201). | P1 (`public-v1`) | abierta |
| PR-03 | **`X-Pay-Mode: test\|live`** como cabecera de las rutas públicas internas (`/merchants/me`, `/api_keys*`, `/mandates*`), fijada por `pay-edge` desde el registro de la clave (D-28). Sin ella o inválida ⇒ 403 `forbidden`. Una clave de un modo no crea claves del otro (403) y no lista, rota ni revoca las del otro (404). Los datos de `test` y `live` no se mezclan. | P1 (`pay-edge`) + integrador | abierta |
| PR-04 | `loadEventContract` (validar un evento emitido contra el AsyncAPI por `subject`) → `@pay/testing`. Hoy vive en `services/pay-merchants/test/support/event-contract.ts`. | P1 | abierta |
| PR-05 | `quoteFee(schedule, channel, gross)` en `@pay/money` (hoy `pay-merchants/src/fees/quote.ts` delega en `splitFee` sin aritmética propia) para que P2 y P3 no lo reescriban. | P1 (`@pay/money`) | abierta |
| PR-06 | Código de error `already_exists` en el catálogo de `@pay/problem` (hoy un NIT repetido sale como `validation_failed` con `errors[].code = already_registered`). | P1 | abierta |
| PR-07 | `api_key.revoked`: agregar la razón `merchant_closed` (hoy cerrar un comercio NO revoca sus claves; los consumidores aplican `merchant.closed`). | P1 (AsyncAPI) | abierta |
| PR-08 | `OperatorGuard` / `OperatorAuthenticator` (credencial JWT de la persona operadora, roles por operación) a `@pay/service-auth`: hoy está copiado en `pay-merchants` y `pay-risk`. Roles propuestos: `merchant_operator`, `kyc_reviewer`, `legal_admin`, `pricing_admin`, `security_operator`, `risk_admin`. | P1 + servicio de identidad (Q-21, Q-23) | abierta |

## Bug encontrado en código ajeno (no corregido)

- `services/pay-edge/src/proxy/edge.pipeline.ts:85` reenvía `x-pay-mode: sandbox` para las claves `test` (`principal.mode === 'test' ? 'sandbox' : 'live'`). D-28 fija el valor `test|live`: con `sandbox`, `pay-merchants` responde 403 en **todas** sus rutas públicas. Dueño: P1.
