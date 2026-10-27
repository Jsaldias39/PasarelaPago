# Decisiones del proyecto

> Respuestas del dueño del proyecto del 2026-10-27, tomadas por cuestionario antes de crear el
> repo. Cada decisión tiene un ID estable con el que se cita en commits, PRs y carriles. Una
> decisión se cambia escribiendo una nueva que la reemplaza, nunca editando la vieja.

## Tomadas

| ID | Tema | Decisión | Consecuencia en el plan |
|---|---|---|---|
| D-01 | Repo | **Monorepo** `Jsaldias39/PasarelaPago` (creado por el dueño el 2026-10-27; se había propuesto `mantra-core-technologies/alovida-pay`, pero la integración no tenía permiso para crear repos en esa organización). Cada servicio se despliega por separado, con su base, su imagen y su CI. | Carpetas `services/*`, `contracts/`, `platform/`. La separación se exige en *runtime* y en CI, no por repo. |
| D-02 | Rol de AloVida respecto del dinero (issue #122 de la bóveda) | **Modo A — orquestador.** Cobra con PSP y bancos con licencia y les paga a los comercios desde una cuenta recaudadora. No es adquirente. | El rail del modo B (`acquirer-settlement`) queda como doble declarado detrás de `settlement.mode` (P2.H2.M8). |
| D-03 | Medios de pago v1 | **QR interoperable, tarjeta vía PSP, transferencia bancaria y saldo AloVida.** Los cuatro. | P3.H3 (medios y bóveda), P4.H2.M7 (transferencia), P2.H1.M8 (saldo). |
| D-04 | Stack | **NestJS 11 + TypeScript**, MikroORM 7, PostgreSQL y Yarn 4: el stack de `mantra-core-health-api`. | Se recicla el código de pagos existente y las skills de la casa. |
| D-05 | Proveedores | ~~Libélula y un banco adquirente de QR~~ **Reemplazada por D-16.** | — |
| D-06 | Moneda | **Solo bolivianos (BOB).** | Sin tipo de cambio. `fx_rate_locks` del modelo no se migra. |
| D-07 | Comisión de AloVida | **Alcance completo:** % por transacción, fijo por transacción, tasa menor por canal directo (7.9) y abono mensual. | P5.H1.M7 (tarifario) y P2.H2.M9 (abono). |
| D-08 | Liquidación a comercios | **Semanal**, con corte en un día fijo. | P2.H2.M2. El día del corte es la pregunta abierta Q-04. |
| D-09 | Despliegue | **Coolify**, como el resto, en un proyecto aparte. | La plataforma se describe en Compose; red aislada para `pay-vault` (P1.H4.M3). |
| D-10 | Bus de eventos | **NATS JetStream.** | Outbox con relé propio; deduplicación por `Nats-Msg-Id` + inbox en cada consumidor. |
| D-11 | Ramas | **`main` + `dev`**, PRs a `dev`, merge con revisión humana. | Igual que los demás repos. |
| D-12 | Convivencia con el monolito | **El monolito pasa a ser cliente:** `mantra-core-health-api` cobra a través de la API pública y retira su M42 por partes. | Carril [`INT`](./carriles/INT-monolito-como-cliente.md) en la ola 4. |
| D-13 | Situación legal y bancaria hoy | **No existe nada todavía:** asesoría legal, cuenta recaudadora y certificación PCI son **objetivos**. Se pidió el mayor alcance posible. | El software se diseña para certificar **PCI DSS v4.0.1 desde el día uno** (`pay-vault`, segmentación) y el carril P1.H4 produce el mapa de alcance y el cuestionario legal. Sin cuenta recaudadora no se puede operar en producción. |
| D-14 | Volumen esperado el primer año | **Más de 100.000 pagos por día.** | Ver la tensión T-01. |
| D-15 | Equipo | **5 programadores, P1–P5.** Los nombres los asigna el dueño después. | Los carriles se escriben por rol. |
| D-16 | Rieles (reemplaza D-05) | **Pasarela propia, sin Libélula.** El banco es el **Banco Mercantil Santa Cruz**: QR interoperable, adquirencia de tarjetas y cuenta recaudadora. Mientras no haya credenciales, simulador. | P4.H2.M3 (tarjeta) y P4.H2.M4 (QR) apuntan al Mercantil. El ruteo queda preparado para un segundo banco. |
| D-17 | Tarjetas | **Por la adquirencia del Banco Mercantil Santa Cruz.** | Resuelve T-02: por defecto la página o los campos de pago del banco; `pay-vault` si el comercio guarda tarjetas. |
| D-18 | Esquema | **Las bases `pay_*` entran al pipeline de `mantra-core-health-model`** (`.puml → SQL/ → base → ORM`). | Cada carril declara su esquema en el modelo (regla 97.1). |
| D-19 | Corte y liberación | **Lunes, T+7.** | P2.H2.M2. |
| D-20 | Redondeo | ***Half-up* al centavo, a favor del comercio.** | `@pay/money` (P1.H1.M3) y P5.H1.M7. |
| D-21 | Facturación de la comisión (SIN) | **Una factura por periodo y por comercio** (comisiones + abono). | P2.H2.M7 exporta el detalle del periodo a M16. |
| D-22 | Contracargos | **Los paga el comercio:** se debitan de su saldo y, si no alcanza, quedan como deuda para el próximo corte. | P3.H2.M6 y P2.H2.M2 (neteo de la deuda). |
| D-23 | Límites de riesgo | **Configurables, sin valores inventados.** Por transacción, por día y por pagador; los valores los carga el negocio o el banco. | P5.H2.M2: el motor arranca sin límites por defecto y lo declara. |
| D-24 | Pagador | **Invitado + billetera opcional:** se paga por QR, tarjeta o transferencia sin cuenta; el saldo AloVida existe solo para usuarios registrados. | P2.H1.M8 y la cuenta `user:{id}:wallet`. |
| D-26 | Capa mock / sandbox (pedido del dueño, 2026-10-27) | **Al final del proyecto se agrega una capa mock** para probar TODO el sistema de punta a punta sin depender de credenciales ni de configuración externa: un banco simulado (`pay-mockbank`) con **la misma interfaz que el conector real**, datos sintéticos y una suite E2E de un comando. Pasar a producción es cambiar configuración, no código. | Ola 4 del plan; carriles P4.H4 y P1.H5. Reglas: el mock cumple el mismo contrato que el conector real y se prueba con los mismos tests de contrato; `PAY_MODE=sandbox\|live` (en `live` el mock se niega a cargar); toda respuesta de sandbox lleva `X-Pay-Mode: sandbox`; escenarios deterministas por importe; nunca se presenta como el banco real (regla 65). |
| D-27 | Claves de API (resuelve Q-17) | Formato `sk_<mode>_<keyBody>_<secret>` con el `key_id` dentro del token, y hash **SHA-256** del secreto (no argon2id): es un secreto aleatorio de 160 bits, no una contraseña, y un KDF lento costaría decenas de ms en cada petición del borde. Comparación en tiempo constante. | Librería `@pay/api-key`; `api_key.created` publica `key_hash` con el patrón `sha256$<hex>`. |
| D-28 | Separación test / live (revisión de seguridad) | El modo de una petición lo fija **`pay-edge`** desde el registro de la clave (`api_key.created` trae `mode`), nunca desde el token ni desde el cliente: lo reenvía en `X-Pay-Mode: test\|live` y **descarta cualquier `X-Pay-Mode` que venga de afuera**. Los servicios dueños filtran por modo. Una clave `test` **no puede crear, listar, rotar ni revocar claves `live`** (403 `forbidden`) y viceversa; los datos de `test` y `live` no se mezclan. | P1.H2 (pay-edge reenvía y sanea la cabecera), P5.H1.M6 (claves filtradas por modo). **P2, P3 y P4** guardan y filtran por `mode` en la ola 2 con una propuesta de contrato (cabecera `X-Pay-Mode` y campo `mode`). |
| D-25 | Equipo | Los nombres de P1–P5 los asigna el dueño después. | `CODEOWNERS` con marcadores. |
| D-29 | Cribado de sanciones por cobro | **Comercio + pagador si lo dio.** Siempre se criba el nombre legal del comercio; si el pagador dio un nombre, también. El pagador invitado sin nombre no bloquea el cobro. (Respuesta del dueño, 2026-10-27.) | P3 manda el nombre a `pay-risk`; P5 alinea `screening_not_provided` con esta regla. |
| D-30 | Resultado `review` del riesgo | **Denegar y registrar.** Un `review` se trata como `deny` con razón registrada (`risk_denied`). Cierra por defecto y no depende de una consola de operadores. | Sin cambio de código en P3; se documenta. La revisión manual queda para cuando exista `pay-backoffice`. |
| D-31 | Servicio de back-office | **`pay-backoffice`** (reemplaza el nombre provisorio `pay-console`). Aún no se construye: las acciones de operador siguen siendo una credencial con rol. | Renombrar `pay-console` en contratos, pruebas y docs. |
| D-32 | Claves de API de un comercio cerrado | **Se revocan al cerrar.** Suspender solo las bloquea y se pueden reactivar. | P5 (`pay-merchants`) revoca por evento; P1 (`pay-edge`) la réplica de claves debe reflejarlo. |

## Hallazgos de la ola 0 que cambian el diseño (spikes ejecutados)

| ID | Hallazgo | Evidencia | Qué cambia |
|---|---|---|---|
| H-TB1 | TigerBeetle: una transferencia **rechazada** no se puede reintentar con el mismo `id` (`id_already_failed`). | [`spikes/tigerbeetle.md`](../spikes/tigerbeetle.md) H-1 | El contrato del ledger recibe `business_ref` + `attempt`; el servidor deriva el id. Ver P2.H1.M4 y P3.H2.M3. |
| H-TB2 | Las rechazadas no se guardan; lote máximo observado 8189; 8 clientes simultáneos en `--development` y 32 en producción; un `cluster_id` equivocado no da error, no responde; ~3 GiB solo para arrancar la réplica. | ídem H-2 a H-6 | P2.H1.M9 (rastro de rechazos en Postgres), *timeouts* propios, cliente de larga vida, dimensionado en Coolify. |
| H-TM1 | Temporal entrega la actividad **al menos una vez**: tras `kill -9` el cuerpo corrió dos veces y el efecto una (por el id idempotente). Recuperación observada ~8,7 s (timeout de la actividad). | [`spikes/temporal.md`](../spikes/temporal.md) | Toda actividad con efecto externo es idempotente por construcción; el tiempo de recuperación entra en la prueba de carga. |
| H-WM1 | Watchman: no pudo cargar las listas vigentes sin internet; `v2-static` trae datos de 2019 (solo sandbox). Un nombre exacto puntuó 0,812 y uno con un error de una letra 0,602 con `minMatch` 0,80. | [`spikes/watchman.md`](../spikes/watchman.md) | El umbral lo fija cumplimiento (Q-12); las listas vigentes salen de un caché propio; Watchman caído ⇒ `review`, nunca `allow`. |
| H-BM1 | Banco Mercantil: **no hay API pública**; hay que pedirle al banco 15 cosas. | [`spikes/banco-mercantil.md`](../spikes/banco-mercantil.md) | P4.H2.M3/M4 contra real quedan condicionados a recibir documentación y ambiente de pruebas (Q-01). El mock (D-26) cubre el hueco sin inventar nada del banco. |
| H-LIC1 | **Formance no tiene licencia declarada** (el repo nuevo) y el viejo es MIT condicionado a `ee/`. Corrige la investigación inicial. | [`spikes/licencias.md`](../spikes/licencias.md) | Descartado como alternativa del ledger. OpenBao es MPL-2.0 (copyleft por archivo). |
| H-CV1 / H-SV1 / H-OB1 | card-vault, Svix y OpenBao: imágenes no accesibles desde el entorno de trabajo y el sistema de permisos denegó ejecutar código de terceros descargado; quedan en revisión documental. | [`spikes/card-vault.md`](../spikes/card-vault.md), [`svix.md`](../spikes/svix.md), [`openbao.md`](../spikes/openbao.md) | Su verificación en ejecución queda pendiente (perfil `full` del Compose, sin verificar). |

## Tensiones registradas (no se resuelven por conveniencia)

| ID | Tensión | Qué hace el plan | Quién decide |
|---|---|---|---|
| T-01 | Más de 100.000 pagos por día (D-14) con Coolify (D-09). Un solo VPS no alcanza para eso con 11 servicios, Temporal, TigerBeetle y NATS. | Coolify puede repartir servicios en **varios servidores**. Cada servicio es *stateless* y escala por réplicas. En la ola 3 hay una **prueba de carga a 2× el volumen objetivo** con el criterio escrito de antemano: si no alcanza con Coolify multiservidor, se vuelve a decidir el despliegue (Kubernetes) antes de producción. | Dueño del proyecto, con los números de la prueba |
| T-02 | ~~Resuelta por D-17.~~ Certificación PCI como objetivo (D-13) + tarjeta como medio (D-03). Guardar tarjetas mete a `pay-vault` en alcance pleno. | Por defecto, la tarjeta entra por los campos alojados del PSP (el PAN no nos toca). `pay-vault` se construye y se segmenta igual, para cuando el comercio guarde tarjetas. | Dueño + QSA |
| T-03 | Modo A sin cuenta recaudadora ni asesoría (D-02 + D-13). | Todo se construye y se prueba contra el simulador. **No se procesa dinero real** hasta que existan la cuenta y el visto bueno legal. Es una condición de salida a producción, no una tarea de software. | Dueño + asesoría legal |

## Preguntas abiertas

Q-01 a Q-10 quedaron respondidas en D-16 a D-25. Salieron nuevas de los spikes:

| ID | Pregunta | Quién | Bloquea |
|---|---|---|---|
| Q-11 | ¿Quién pide al Banco Mercantil los 15 puntos de `spikes/banco-mercantil.md` y cuándo? | Dueño | P4.H2.M3/M4 contra real |
| Q-12 | Umbrales de cribado (`review`/`deny`) y qué campos se envían a Watchman; ¿se exigen listas bolivianas? | Cumplimiento | P5.H2.M3 |
| Q-13 | Formance: ¿hace falta confirmar su licencia por escrito, o se descarta del todo? | Dueño | Nada (TigerBeetle pasó) |
| Q-14 | Formato exacto de las claves Ed25519 `whsk_`/`whpk_` (el spec no fija los bytes). El código usa 64 bytes (semilla ‖ pública) y 32 bytes. | P1 + quien consuma `v1a` | P1.H3 si algún comercio pide `v1a` |
| Q-15 | Mandatos (7.7 y 7.8): ¿ALOVIDA tiene un comercio `mc_` propio para cobrar comisiones (7.8)? ¿Se admiten beneficiarios externos y cómo se registran? Hoy `MandateCreate` solo admite comercios de la pasarela. | Dueño + P5 | P5.H3, `public-v1.yaml` |
| Q-16 | `PaymentIntent`: ¿cuál es el estado inicial y cuándo se emite `payment_intent.requires_action` además de `created`? Faltan códigos de error para «riesgo denegó» y «tarjeta rechazada» en el catálogo de `@pay/problem`. | P3 | P3.H1, `asyncapi/payments.yaml` |
| Q-17 | ~~Resuelta por D-27.~~ La API key debe llevar su `key_id` embebido en el secreto para que `pay-edge` la encuentre sin recorrer todos los hashes; definir el formato. | P5 + P1 | P1.H2.M1 |
| Q-18 | ¿Evento `payout.in_transit` y recurso público `dispute`? El estado público de payout existe pero no tiene evento; las disputas solo existen como eventos. | P2 + P3 | `asyncapi/ledger-settlement.yaml` |
| Q-20 | Saldo AloVida: ¿quién emite y verifica el `wallet_authorization` (token de un solo uso del usuario, atado a comercio e importe) y con qué formato? Alternativa: el intento queda `requires_action` hasta que el usuario confirma en su sesión. | Dueño + identidad + P3 | P3.H3.M4 |
| Q-21 | Conciliación: ¿qué roles (`settlement_operator`, `settlement_admin`) existen en el servicio de identidad y quién tiene el tope para aprobar ajustes? | Dueño + contabilidad | P2.H2 |
| Q-22 | Payouts: ¿dónde vive el registro de las cuentas de liquidación de cada comercio (banco, titular, número) y quién lo valida? Hoy el contrato usa `destination_ref`, una referencia opaca; la pasarela no mueve ni guarda números de cuenta. Es dato personal/financiero sensible. | Dueño + P5 + asesoría legal | P2.H2.M3, `internal-connectors-v1` `/transfers` |
| Q-19 | Bóveda: ¿quién aloja el formulario de captura de tarjeta (el banco o `pay-vault`) y `reveal` devuelve la tarjeta o hace de proxy hacia el proveedor? | Dueño + P3 + QSA | P3.H3 |

(Q-01 a Q-10, ya respondidas: Lo que queda fuera del software está en las tensiones T-01 (volumen contra Coolify) y T-03 (cuenta recaudadora y visto bueno legal).)
