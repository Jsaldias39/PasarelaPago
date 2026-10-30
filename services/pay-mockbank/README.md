# pay-mockbank — banco simulado de la capa sandbox (D-26, P4.H4)

> **Es un doble.** NO es el Banco Mercantil ni se parece a su API (que no conocemos: Q-01 y Q-11 siguen abiertas, `docs/spikes/banco-mercantil.md`).
> Todo campo, ruta, referencia y cuenta es **FICTICIO** y lleva el rótulo SANDBOX. Los adaptadores reales **no** deben copiarlos.

Servicio independiente con **su propia base** (`pay_mockbank`) que expone lo que expondría un banco para que el sistema completo se pruebe **sin credenciales
del banco**: cobros por QR, autorización/captura/anulación de tarjeta, reembolsos, transferencias salientes, extracto (JSON, CSV y `camt.053`) y **callbacks
firmados con Standard Webhooks** hacia `pay-connectors`. Se comporta distinto según el **importe**, de forma determinista.

- **Puerto:** `3112` (los 11 servicios de la pasarela usan 3101 a 3111; el arnés e2e asigna puertos libres propios). Ver `.env.example`.
- **Contrato:** `openapi/mockbank-v1.proposal.yaml` — **PROPUESTA** (no vive en `contracts/`; ver `docs/trabajo/ola-2/P4/PROPUESTAS.md`). Las pruebas validan sus respuestas contra ese archivo.
- **Salud:** `GET /health/live` · `GET /health/ready` (la base propia). **Errores:** RFC 9457 con `code` estable; los del banco (`bank_unavailable`, `*_not_found`, `invalid_state`) son los únicos cuerpos que el conector toma como definitivos.

## Guardia de modo (D-26, P4.H4.M5)

- `PAY_MODE` es **obligatorio y solo admite `sandbox`**. Con `live`, sin definir o mal escrito el proceso **no arranca** (código ≠ 0). Este servicio no existe en producción.
- En sandbox **toda respuesta** (salud, 403, 404, errores, CSV y XML incluidos) lleva `X-Pay-Mode: sandbox` (`contracts/openapi/common.yaml`, `XPayModeSandbox`).
- Toda petición del banco lleva `X-Pay-Mode: test` (el modo de la clave, D-28): ausente, repetido, inválido o `live` ⇒ `403` **antes** de cualquier efecto.
- Identidad de servicio: el banco lo llama `pay-connectors`; el pagador y los controles del administrador, `pay-mockbank` (el CLI). Cualquier otro ⇒ `403`.

## Escenarios deterministas por importe (P4.H4.M3)

Los **centavos** del importe (`amount_minor % 100`) eligen el escenario; los centavos 10 a 99 se aprueban. Un test por fila: `test/scenarios.spec.ts`. La misma tabla, con las
constantes de E4/E8, está en `docs/trabajo/ola-2/P4/ESCENARIOS.md` (y `test/escenarios-doc.spec.ts` impide que se desvíen).

| Centavos | Escenario | Importe | Qué hace el banco |
|---|---|---|---|
| `00` | aprobado | `10000` | el callback `captured` se entrega enseguida |
| `01` | rechazado | `10001` | `failed` con `card_declined` de forma síncrona; nunca se paga |
| `02` | demorado | `10002` | pago y callback `MOCKBANK_DELAY_MS` después (5 s) |
| `03` | callback duplicado | `10003` | el mismo callback ×3 con el mismo id de evento |
| `04` | fuera de orden | `10004` | llega `captured` y DESPUÉS `authorized` |
| `05` | callback perdido | `10005` | nunca se entrega; solo la consulta de estado revela `captured` |
| `06` | banco caído | `10006` | `503 bank_unavailable`, no crea nada (seguro reintentar) |
| `07` | timeout ambiguo | `10007` | crea el cobro y la conexión se corta sin responder (regla 11: pudo ejecutarse) |
| `08` | nunca pagado | `10008` | `expired` al llegar `expires_at` |
| `09` | extracto con diferencia | `10009` | cobra bien; el extracto trae Bs 1,00 menos |

**Transferencias salientes:** `00`/otros pagada · `01` fallida `rejected_by_bank` · `02` en tránsito `MOCKBANK_DELAY_MS` · `06` caído · `07` sin respuesta, `17` un proxy contesta 502 con HTML, `27` socket reseteado (en los tres la orden **se ejecuta**) · `08` en tránsito para siempre.
**Tarjeta:** `01` `declined` · `06` caído · `07` autoriza y corta la conexión · el resto `authorized`, que se captura (total o parcial) o se anula.

## Qué expone

| Ruta (`/sandbox/…`) | Para qué |
|---|---|
| `POST charges` · `GET charges/{ref}` · `PUT charges/{ref}/qr` · `POST charges/{ref}/cancel` | cobro QR / tarjeta de un paso / transferencia entrante; el QR que emitió la pasarela se registra para que el pagador lo pueda pagar |
| `POST refunds` · `GET refunds/{ref}` | reembolsos idempotentes; `404 refund_not_found` es la respuesta explícita de «no lo tengo» |
| `POST transfers` · `GET transfers/{ref}` | transferencia saliente; `404 transfer_not_found` explícito |
| `POST card-authorizations` · `…/{ref}/capture` · `…/{ref}/void` | ciclo de tarjeta. **Solo un token de prueba `tok_…`: un PAN (una ventana de 13 a 19 dígitos que pase Luhn, sola o dentro del valor) se rechaza con 422 sin repetirlo en la respuesta, en logs ni en ningún lado. Un token de la bóveda (`tok_` + 24 hexadecimales) nunca se toma por un PAN** |
| `GET statement?from&to&format=json\|csv\|camt053&account=collections\|transfers` | extracto; `camt053` usa la estructura **pública** de ISO 20022 `camt.053.001.02` (el perfil real del banco no se conoce y no se inventa); el CSV neutraliza fórmulas |
| `GET probe` | sonda de salud del banco |

Los callbacks salen a `MOCKBANK_CALLBACK_URL` (`POST /callbacks/mock` de `pay-connectors`) con cabeceras `webhook-id`, `webhook-timestamp` y `webhook-signature`, firmados con
`MOCKBANK_WEBHOOK_SECRET` (sintético). Si el receptor responde distinto de 2xx, el banco reintenta con backoff como lo haría uno real; el mismo evento conserva su `webhook-id`.

### Pagador simulado (P4.H4.M4) y controles — identidad `pay-mockbank`

- `POST payer/pay` `{ qr_payload }` — **«paga» un QR emitido por la pasarela**: lo decodifica con `pay-qr` (`POST /qr/decode`: CRC, moneda `068`, monto), comprueba que el banco lo conoce y que el monto coincide, y paga. Todo se valida **antes** de tocar nada. Idempotente.
- `POST payer/transfer-in` `{ reference, amount_minor }` — **el pagador transfiere al banco** con la referencia de las instrucciones (E8): la línea aparece en la cuenta `transfers` del extracto y el banco **no avisa** a nadie.
- `POST admin/deliver` · `POST admin/reset` · `PUT admin/down` · `POST admin/statement-lines` — para las pruebas y el arnés.

CLI (`dist/cli.js`, bin `mockbank`): `MOCKBANK_URL=http://127.0.0.1:3112 mockbank pay <payload-del-QR>` · `mockbank transfer <referencia> <centavos>`.
Con `MOCKBANK_PAYER_MODE=auto` (por defecto) el banco paga cada QR solo, según su escenario; con `manual` el QR queda abierto hasta que el pagador lo paga.

## Cómo lo usa `pay-connectors`

`pay-connectors` con `MOCKBANK_URL=http://127.0.0.1:3112` hace que el conector **`mock`** hable con este servicio por HTTP en vez de usar su banco en memoria (Decisión D-P4-42,
`docs/trabajo/ola-2/P4/DECISIONES-TOMADAS.md`), y que el conector `bank_transfer` lea su extracto de la cuenta `transfers`. Los callbacks vuelven firmados a `POST /callbacks/mock`.
El secreto tiene que ser el mismo en los dos lados: `MOCKBANK_WEBHOOK_SECRET` = `PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET`.

## Comandos

```bash
yarn typecheck && yarn build && yarn test     # Postgres (54321) real; las pruebas de arranque y del pagador lanzan procesos reales (dist/) y compilan pay-qr
node dist/main.js                              # con el .env.example cargado
```
