# Decisiones y ambigüedades tomadas por P1 en la ola 1

> Cada decisión se tomó **sin confirmación** porque el plan no la fijaba. Lleva su supuesto y a quién confirmársela. Si se cambia, se escribe
> una nueva que la reemplaza (no se edita la vieja).

| ID | Decisión | Por qué | Confirmar con |
|---|---|---|---|
| DT-1 | **Redis caído ⇒ el borde deja pasar** (fail-open) y lo registra; la protección de abuso se degrada, el servicio no se cae. | Disponibilidad del cobro antes que el freno de abuso; la autenticación NO depende de Redis. | Dueño del proyecto (riesgo/seguridad) |
| DT-2 | **Comercio desconocido en la réplica ⇒ activo** (solo `suspended`/`closed` bloquean). | Una clave válida implica que el comercio existe; bloquear por ausencia haría que un evento perdido tumbe a un comercio. | P5 (`pay-merchants`) |
| DT-3 | Limitador de **ventana fija** con Lua atómico (INCR + TTL con reparación), no ventana deslizante. | Simple y atómico; admite ráfagas de hasta 2× en el borde de la ventana. | P1 (cambiar si la carga de la ola 3 lo exige) |
| DT-4 | Límites por defecto: **300 / 600 / 30 por 60 s** (por IP, por clave, fallos de autenticación por IP). | Sin cifras de negocio; son configurables (`RATE_LIMIT_*`). | Negocio, con los números de la ola 3 |
| DT-5 | El cuerpo se **lee después de autenticar** y con tope (1 MiB); se reenvían los **bytes exactos**. | No bufferear nada de quien no se autenticó; la firma/idempotencia del dueño ve el mismo cuerpo. | — |
| DT-6 | Clave inexistente, mal formada, revocada, de otro modo o con secreto equivocado ⇒ **la misma respuesta 401** (solo cambia `request_id`). | No filtrar qué claves existen. | — |
| DT-7 | `pay-edge` y `pay-webhooks` usan **`pg` directo**, no MikroORM. | Sin entidades de dominio complejas; evita el desajuste de tipos 7.2.5 (propuesta 1); SQL de referencia al modelo (D-18). | P1/P3 (convención de la plantilla) |
| DT-8 | `pay-webhooks` **no** tiene outbox/relé propio. | No publica eventos de dominio en la ola 1. | P1 (si hace falta `webhook_endpoint.disabled`) |
| DT-9 | **Eventos públicos = 21 tipos** (payment_intent, refund, dispute, payout, mandate, scheduled_payment). Ledger, api_key, merchant, fee_schedule, settlement.batch, reconciliation y connector son **internos**. | El contrato no define el catálogo (propuesta 6). | P3, P2, P5 (¿falta alguno?) |
| DT-10 | **Política de payload por lista de permitidos** de nombres de campo; campo fuera de lista ⇒ se descarta y se registra su nombre; valor con correo/teléfono/tarjeta ⇒ **se rechaza el evento entero**. | «Solo ids y montos» (M5); un valor sospechoso es un defecto del publicador. | P3 (campos nuevos en los eventos) |
| DT-11 | Reintentos: **8 intentos** (0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h) con jitter ±20 %; todo no-2xx es fallo salvo 410. | Escalera de Svix, el motor al que se va a migrar. | P1 |
| DT-12 | **410 ⇒ endpoint deshabilitado** (`gone_410`) y sin reintentos; **5 entregas agotadas seguidas ⇒ `too_many_failures`**. Un 3xx cuenta como fallo (no se siguen redirecciones). | REQ-P1-6; el umbral de 5 es una cifra propia. | Negocio |
| DT-13 | Secretos de firma **sellados con AES-256-GCM** (clave `WEBHOOKS_SECRET_KEK` del entorno, atada al id del endpoint); en la tabla de idempotencia el secreto se guarda sellado para poder repetir la respuesta. | Regla 90: nada en claro. | Seguridad (en producción la clave vendrá de OpenBao) |
| DT-14 | Esquema `v1a`: se muestra la clave **pública** `whpk_…`; la secreta no sale. | Es lo que verifica el comercio. | — |
| DT-15 | **Gracia de rotación: 24 h** (dos firmas en el mismo mensaje). | Tiempo razonable para actualizar al comercio; configurable. | Negocio |
| DT-16 | `enabled_events` solo admite los 21 públicos o `*`. | El comercio no debe creer que recibe eventos internos. | P1 / propuesta 6 |
| DT-17 | Entregas en vuelo por endpoint: **2**; lote por endpoint: **10**. | Un endpoint lento no ahoga a los demás (hallazgo de seguridad del coordinador). | — |
| DT-18 | Plazo duro de pared por entrega (15 s) + tope de inactividad (10 s); **no se lee la respuesta**. | Evita DoS por goteo. | — |
| DT-19 | El borde **rechaza** cuerpos con un número de tarjeta (Luhn, 13–19 dígitos) y JSON inválido (422). Se revisa **cada token** del texto (no el objeto de `JSON.parse`, que pierde las claves duplicadas) y las corridas de separadores se colapsan antes de buscar; se prueba toda ventana de 13–19 dígitos de cada corrida. **Costo aceptado: se rechazan de más las cadenas numéricas al azar (≈10 % con 13 dígitos, ≈65 % con 16, ≈97 % con 20)**; alternativa con prefijo de marca (IIN) pendiente de P3/QSA. | Mantener `pay-edge` fuera del CDE. | P3 y QSA |
| DT-20 | **`SvixEngine` no se escribió.** | La documentación de Svix no es accesible desde el entorno (DNS bloqueado) y la regla 00 prohíbe inventar APIs de terceros. Se dejó la interfaz `DeliveryEngine` y una **suite de contrato** que el adaptador deberá pasar. | P1, cuando haya acceso a Svix |
| DT-21 | La salida por **proxy sin ruta a la red interna** (M6) no está implementada en código: es un control de despliegue. El código fija la IP validada, no sigue redirecciones y revalida en cada entrega. | Depende de Coolify/red. | P1 (plataforma) |
| DT-22 | `pay-webhooks` no replica comercios: un evento de un comercio sin endpoints se consume sin entregas y se cuenta (`noEndpoints`). | No hay réplica en ese servicio. | P5 |
| DT-23 | **Contrato congelado = el encabezado de la versión BASE dice `v1-frozen`** (no se puede esquivar cambiándolo en el mismo PR). | Regla de congelamiento. | P1 |
| DT-24 | Firma Standard Webhooks: el `webhook-id` es el **`id` del CloudEvent** (igual para todos los endpoints y reintentos); la marca de tiempo es **la de cada intento**. | Los reintentos tardíos vencerían la tolerancia de 5 min si reusaran la primera marca. | — |

## Ambigüedades abiertas

| ID | Ambigüedad | Supuesto tomado | A quién |
|---|---|---|---|
| A-1 | ¿`pay-connectors` es CDE (recibe el PAN con `reveal`) o conectado (si la bóveda reenvía)? | CDE provisoria (`pci-alcance.md`). | P3 + P4 + QSA |
| A-2 | ¿Quién aloja el formulario de captura de tarjeta (banco o bóveda)? | No resuelto; define SAQ A o D. | Banco Mercantil + P3 |
| A-3 | ¿Los extractos del banco pueden traer PAN completo? | No. | Banco Mercantil |
| A-4 | Texto de RD 079/2022, RD 069/2021 y rol de la ASFI. | No se leyeron; se pide a la asesoría (`preguntas-legales.md`). | Asesoría legal |
| A-5 | ¿Un evento de un tipo público puede traer campos nuevos? | Se descartan hasta que el contrato los declare (DT-10). | P2, P3, P5 |

### DT-19 — dato nuevo (ola 5, carril INT)
Observado con un cliente real: la API del monolito envió un UUID en `metadata` y `pay-edge` respondió `422 card_number_detected` (el guardia de PAN lo leyó como tarjeta). Un UUID es un identificador legítimo y común, así que el falso positivo no es teórico. El cliente de la API lo esquiva no enviando `metadata`. Sigue abierta la decisión de exigir además el prefijo de marca (IIN) o excluir formas de UUID (P1/P3 y QSA). Evidencia: `docs/trabajo/ola-5/INT/INFORME.md`.
