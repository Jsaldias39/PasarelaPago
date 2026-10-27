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
| D-05 | Proveedores | **Libélula** y un **banco adquirente de QR** como destino; **mientras tanto, simulador**. | El simulador (P4.H1.M4) es el conector de las olas 1 y 2. Los reales entran en la ola 3 o cuando haya credenciales. |
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

## Tensiones registradas (no se resuelven por conveniencia)

| ID | Tensión | Qué hace el plan | Quién decide |
|---|---|---|---|
| T-01 | Más de 100.000 pagos por día (D-14) con Coolify (D-09). Un solo VPS no alcanza para eso con 11 servicios, Temporal, TigerBeetle y NATS. | Coolify puede repartir servicios en **varios servidores**. Cada servicio es *stateless* y escala por réplicas. En la ola 3 hay una **prueba de carga a 2× el volumen objetivo** con el criterio escrito de antemano: si no alcanza con Coolify multiservidor, se vuelve a decidir el despliegue (Kubernetes) antes de producción. | Dueño del proyecto, con los números de la prueba |
| T-02 | Certificación PCI como objetivo (D-13) + tarjeta como medio (D-03). Guardar tarjetas mete a `pay-vault` en alcance pleno. | Por defecto, la tarjeta entra por los campos alojados del PSP (el PAN no nos toca). `pay-vault` se construye y se segmenta igual, para cuando el comercio guarde tarjetas. | Dueño + QSA |
| T-03 | Modo A sin cuenta recaudadora ni asesoría (D-02 + D-13). | Todo se construye y se prueba contra el simulador. **No se procesa dinero real** hasta que existan la cuenta y el visto bueno legal. Es una condición de salida a producción, no una tarea de software. | Dueño + asesoría legal |

## Preguntas abiertas (necesarias, todavía sin respuesta)

| ID | Pregunta | Por qué importa | Bloquea |
|---|---|---|---|
| Q-01 | ¿Qué banco será el adquirente del QR y de la cuenta recaudadora? | Define el perfil del QR, el formato de los extractos y el conector real | P4.H2.M4 contra real (se avanza contra el simulador) |
| Q-02 | ¿Hay contrato y sandbox con Libélula para AloVida como plataforma (no como comercio)? | El manual actual se alineó como comercio | P4.H2.M3 contra real |
| Q-03 | ¿Las bases `pay_*` entran al pipeline de `mantra-core-health-model`? | Regla 97.1 de la casa | El esquema de todos los carriles (supuesto: sí) |
| Q-04 | ¿Qué día es el corte semanal y con qué desfase se libera el saldo (T+N)? | Liquidación (D-08) | P2.H2.M2 (supuesto: lunes, T+7) |
| Q-05 | ¿Regla de redondeo de la comisión y quién absorbe el centavo? | Cuadre exacto | P5.H1.M7 (supuesto: *half-up* a favor del comercio) |
| Q-06 | ¿La comisión de AloVida se factura (SIN) por cada cobro o por el periodo? | Facturación legal de la comisión | P2.H2.M7 (exportación a M16) |
| Q-07 | ¿Quién responde ante un contracargo de tarjeta en modo A: el comercio, AloVida o el PSP? | Asiento de la disputa | P3.H2.M6 (supuesto: se debita al comercio) |
| Q-08 | ¿Límites de monto por transacción y por día que exige el banco o el regulador? | Reglas de riesgo | P5.H2.M2 (supuesto: configurables, sin valor por defecto inventado) |
| Q-09 | ¿El pagador final (paciente) necesita cuenta en la pasarela o paga como invitado? | Billetera del usuario (saldo AloVida) | P2.H1.M8 (supuesto: billetera solo para usuarios registrados en AloVida) |
| Q-10 | Nombres y usuarios de GitHub de P1–P5 | Reparto y CODEOWNERS | `CODEOWNERS` |
