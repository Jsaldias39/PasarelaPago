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
| D-25 | Equipo | Los nombres de P1–P5 los asigna el dueño después. | `CODEOWNERS` con marcadores. |

## Tensiones registradas (no se resuelven por conveniencia)

| ID | Tensión | Qué hace el plan | Quién decide |
|---|---|---|---|
| T-01 | Más de 100.000 pagos por día (D-14) con Coolify (D-09). Un solo VPS no alcanza para eso con 11 servicios, Temporal, TigerBeetle y NATS. | Coolify puede repartir servicios en **varios servidores**. Cada servicio es *stateless* y escala por réplicas. En la ola 3 hay una **prueba de carga a 2× el volumen objetivo** con el criterio escrito de antemano: si no alcanza con Coolify multiservidor, se vuelve a decidir el despliegue (Kubernetes) antes de producción. | Dueño del proyecto, con los números de la prueba |
| T-02 | ~~Resuelta por D-17.~~ Certificación PCI como objetivo (D-13) + tarjeta como medio (D-03). Guardar tarjetas mete a `pay-vault` en alcance pleno. | Por defecto, la tarjeta entra por los campos alojados del PSP (el PAN no nos toca). `pay-vault` se construye y se segmenta igual, para cuando el comercio guarde tarjetas. | Dueño + QSA |
| T-03 | Modo A sin cuenta recaudadora ni asesoría (D-02 + D-13). | Todo se construye y se prueba contra el simulador. **No se procesa dinero real** hasta que existan la cuenta y el visto bueno legal. Es una condición de salida a producción, no una tarea de software. | Dueño + asesoría legal |

## Preguntas abiertas

Ninguna a la fecha. Q-01 a Q-10 quedaron respondidas en D-16 a D-25 (2026-10-27). Lo que queda
fuera del software está en las tensiones T-01 (volumen contra Coolify) y T-03 (cuenta recaudadora
y visto bueno legal).
