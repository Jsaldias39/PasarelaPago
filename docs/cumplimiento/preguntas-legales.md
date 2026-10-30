# Cuestionario para la asesoría legal · modo A en Bolivia · P1.H4.M2

> Dueño: **P1** · Destinatario: la asesoría legal que el dueño del proyecto contrate (hoy **no existe**, D-13) · Peldaño: `WRITTEN`.
> Condición de salida a producción: **T-03** — sin cuenta recaudadora ni visto bueno legal no se procesa dinero real.

## Cómo leer este documento

- **No es una opinión jurídica.** Cada pregunta nombra la fuente que hay que consultar y dice qué **supuesto toma hoy el software**,
  para que la respuesta del abogado se pueda convertir directamente en un cambio (o en la confirmación de que no hace falta ninguno).
- Las normas se nombran como el plan las nombra (RD 079/2022 y RD 069/2021 del BCB, rol de la ASFI). **Quien lee esto no tuvo acceso al
  texto de ninguna de ellas desde el entorno de desarrollo**: no se parafrasea su contenido, se pide que el asesor lo confirme. Las demás
  normas marcadas con (†) son candidatas que el asesor debe confirmar si aplican; no son una afirmación de que apliquen.
- Cada pregunta tiene un número estable (`L-nn`). Una respuesta se registra abajo de la pregunta con fecha y quién la dio, y el cambio
  que provoca se enlaza a su decisión (`D-nn`) o a su issue. **Las preguntas no se renumeran.**

## Lo que el software supone hoy (resumen)

| Tema | Supuesto vigente | Decisión |
|---|---|---|
| Rol | **Modo A — orquestador**: AloVida cobra con un banco y un PSP con licencia y paga a los comercios desde una cuenta recaudadora; **no es adquirente**. | D-02 |
| Moneda | Solo bolivianos (BOB). | D-06 |
| Medios | QR interoperable, tarjeta por la adquirencia del banco, transferencia bancaria y **saldo AloVida** (billetera). | D-03, D-17 |
| Pagador | Invitado (sin cuenta) o usuario con billetera opcional. | D-24 |
| Liquidación | Semanal, corte lunes, liberación a T+7. | D-08, D-19 |
| Contracargos | Los paga el comercio: se debitan de su saldo y, si no alcanza, quedan como deuda para el próximo corte. | D-22 |
| Comisión | % + fijo + abono mensual; **una factura por periodo y por comercio**. | D-07, D-21 |
| Banco | Banco Mercantil Santa Cruz: QR, adquirencia y cuenta recaudadora. Sin ambiente de pruebas conocido. | D-16 |
| Tarjeta | El PAN no nos toca por defecto (campos alojados del banco); bóveda propia solo si el comercio guarda tarjetas. | D-17, T-02 |

## A. Encuadre del modo A

**L-01 · ¿Qué actividad regulada es, jurídicamente, lo que hace AloVida en el modo A?**
- *Detalle:* recibe fondos del pagador a través del banco, los retiene en una cuenta y los transfiere al comercio una semana después.
- *Fuente:* RD 079/2022 y RD 069/2021 del BCB; competencia de la ASFI. (†) Ley N.º 393 de Servicios Financieros.
- *Qué se necesita:* clasificación de la actividad y lista de **licencias, autorizaciones o registros** que AloVida debe tener antes de operar, con plazos y requisitos de capital o garantía.
- *Supuesto del software:* AloVida **no** es entidad financiera ni adquirente; el banco aporta las licencias (D-02, D-16).
- *Si la respuesta cambia:* puede obligar a mover la custodia al banco, a cambiar el flujo de fondos del ledger o a no salir a producción hasta tener la licencia.

**L-02 · ¿El hecho de que el banco tenga licencia alcanza para cubrir a AloVida, o AloVida necesita la suya?**
- *Fuente:* lo mismo que L-01.
- *Supuesto:* alcanza con el banco (modo A «orquestador»).

**L-03 · ¿Qué se puede decir al público y a los comercios sobre qué es AloVida?** (nombre comercial, uso de «pasarela de pagos», «billetera», «cuenta»).
- *Fuente:* normas de publicidad y de denominaciones reservadas para entidades financieras (a confirmar por el asesor).
- *Supuesto:* se usa «pasarela de pagos» y «saldo AloVida» sin restricción.

## B. Cuenta recaudadora y custodia de fondos de terceros

**L-04 · ¿A nombre de quién debe estar la cuenta recaudadora?** ¿AloVida, un fideicomiso, una cuenta de custodia del banco?
- *Supuesto:* una cuenta **a nombre de AloVida** en el Banco Mercantil, de la que se paga a los comercios.
- *Si cambia:* el ledger (`pay-ledger`) modela las cuentas del comercio y de la plataforma; una cuenta de fideicomiso exige segregar por comercio.

**L-05 · ¿Los fondos de los comercios están protegidos si AloVida entra en concurso o es embargada?** ¿Hace falta segregarlos patrimonialmente?
- *Supuesto:* el ledger distingue saldo del comercio y de la plataforma, pero **en el banco es una sola cuenta**.

**L-06 · ¿La retención de fondos hasta T+7 (D-19) es lícita y bajo qué condiciones contractuales?** ¿Hay un plazo máximo para mantener fondos de terceros antes de liquidarlos?
- *Supuesto:* se retiene 7 días desde el cobro; después se paga en el corte del lunes.
- *Si cambia:* `pay-settlement` (corte, liberación) y la columna `available_minor` de `GET /balance`.

**L-07 · ¿Se puede cobrar o pagar intereses sobre los fondos retenidos?** ¿A quién pertenecen los rendimientos de la cuenta?
- *Supuesto:* el software **no** calcula ni distribuye rendimientos.

**L-08 · ¿Qué ocurre ante un embargo o una orden judicial sobre el saldo de un comercio?** ¿Cómo se ejecuta y con qué rapidez hay que responder?
- *Supuesto:* no existe en el software. Se necesitaría un estado de retención por orden judicial en el ledger.

## C. Saldo AloVida (billetera)

**L-09 · ¿Mantener un saldo a favor de usuarios registrados (D-24) es emisión de dinero electrónico o de un instrumento electrónico de pago regulado?**
- *Fuente:* RD 079/2022 y RD 069/2021 (confirmar cuál regula instrumentos electrónicos de pago); ASFI.
- *Supuesto:* el saldo es un **medio de pago de uso interno** (como un crédito), sin retiro en efectivo; solo existe para usuarios registrados.
- *Si cambia:* puede obligar a quitar el medio `wallet` de la etapa 1 (D-03), limitar saldos o exigir identificación reforzada.

**L-10 · ¿Hay límites de saldo o de transacción para billeteras? ¿Hay un nivel de identificación mínimo para tenerla?**
- *Supuesto:* no hay límites cargados; **D-23** manda que el motor de riesgo arranque sin límites por defecto, que los cargue el negocio o el banco.

**L-11 · ¿Se puede devolver el saldo AloVida al pagador en dinero? ¿En qué plazo y con qué constancia?**

## D. Identificación, prevención de lavado y sanciones

**L-12 · ¿Qué obligaciones de debida diligencia (KYC) tiene AloVida frente a los comercios?** ¿Qué documentos son obligatorios y cuál es el nivel según el monto?
- *Fuente:* normativa de la UIF y de la ASFI sobre prevención de legitimación de ganancias ilícitas (†) a confirmar por el asesor.
- *Supuesto:* `pay-merchants` pide KYC al dar de alta; la lista exacta de documentos está en el carril P5 y **no** viene de una norma.

**L-13 · ¿Qué obligaciones hay frente al pagador «invitado» (D-24) que paga sin cuenta?** ¿Hace falta identificarlo a partir de cierto monto?
- *Supuesto:* el invitado no se identifica.

**L-14 · ¿Hay que reportar operaciones sospechosas o superiores a un umbral?** ¿A quién, en qué formato y con qué plazo? ¿Quién es el oficial de cumplimiento?
- *Supuesto:* el software no genera reportes regulatorios.

**L-15 · ¿Contra qué listas de sanciones y de personas expuestas políticamente hay que cribar, y con qué frecuencia?**
- *Supuesto:* `pay-risk` usa **moov Watchman** (listas públicas de EE. UU. y otras que Watchman incluya); **no hay una lista boliviana** cargada.

**L-16 · ¿Cuánto tiempo hay que conservar los registros de transacciones, KYC y auditoría? ¿Se pueden borrar a pedido del titular?**
- *Supuesto:* los registros de dinero son de solo-agregar (nunca `UPDATE` ni `DELETE`); no hay política de retención ni de borrado definida.

## E. Contratos y relación con los comercios

**L-17 · ¿Qué cláusulas obligatorias debe tener el contrato con el comercio?** (comisiones, plazos de liquidación, contracargos, suspensión, cierre, responsabilidad, jurisdicción).
- *Supuesto:* `pay-merchants` guarda un contrato **versionado**; el texto lo aporta el negocio.

**L-18 · ¿Es válido debitar del saldo del comercio los contracargos y, si no alcanza, dejar la deuda para el próximo corte (D-22)?** ¿Hace falta consentimiento expreso y en qué forma?
- *Supuesto:* sí, con el contrato aceptado. La deuda no genera intereses en el software.

**L-19 · ¿Se puede suspender o cerrar un comercio y retener sus fondos? ¿Con qué procedimiento y plazo para devolverlos?**
- *Supuesto:* `merchant.suspended` detiene el cobro (la API responde 403); qué pasa con los fondos retenidos **no está definido**.

## F. Pagos programados y débitos recurrentes

**L-20 · ¿Qué consentimiento del pagador exige un mandato de pago recurrente o programado?** ¿Cómo se acredita, se revoca y se conserva?
- *Fuente:* normas de débitos automáticos / protección al consumidor (†) a confirmar por el asesor.
- *Supuesto:* `POST /mandates` representa la autorización; no hay firma electrónica del pagador en el software.

**L-21 · ¿Qué se debe hacer ante el fondo insuficiente en un cobro programado (reintentos, aviso, cobro de comisión)?**
- *Supuesto:* `scheduled_payment.insufficient_funds` reintenta según la política del carril P5.

## G. Facturación e impuestos

**L-22 · ¿Cómo se factura la comisión de AloVida al comercio?** ¿Una factura por periodo y por comercio es válida ante el SIN (D-21)? ¿Qué debe llevar (NIT, código de control o el sistema vigente)?
- *Fuente:* normativa de facturación electrónica del SIN, a confirmar por el asesor.
- *Supuesto:* una factura por periodo y comercio, con el detalle exportado a M16 (`pay-settlement`, P2.H2.M7).

**L-23 · ¿El importe cobrado en nombre del comercio es un ingreso de AloVida o un movimiento de fondos de terceros a efectos tributarios (IVA, IT)?** ¿Qué retenciones hay que practicar?
- *Supuesto:* solo la **comisión** es ingreso de AloVida; el principal es de terceros. El software no calcula impuestos.

**L-24 · ¿Los reembolsos y contracargos requieren notas de crédito o de débito?**

## H. Datos personales y tarjetas

**L-25 · ¿Qué normativa de protección de datos personales aplica en Bolivia a los datos de pagadores y comercios?** ¿Hay obligaciones de consentimiento, registro de bases de datos o notificación de incidentes?
- *Supuesto:* privacidad por diseño: los eventos y los webhooks no llevan datos personales; los datos de salud del monolito **no** llegan a la pasarela.

**L-26 · ¿Hay obligación de almacenar datos de transacciones dentro del país?** ¿Se puede alojar la plataforma fuera de Bolivia?
- *Supuesto:* se despliega en Coolify (D-09); la ubicación del servidor no está decidida.

**L-27 · ¿Qué se exige a una entidad que maneja datos de tarjeta además de PCI DSS?** (requisitos del banco adquirente, de las marcas, del BCB).
- *Relación:* [`pci-alcance.md`](./pci-alcance.md).

## I. Responsabilidades y reclamos

**L-28 · ¿Quién responde frente al pagador ante un cobro duplicado, un fraude o un error del banco: AloVida, el comercio o el banco?** ¿Qué plazo y qué canal de reclamos son obligatorios?

**L-29 · ¿Qué información mínima debe mostrarse al pagador antes de pagar y en el comprobante?**

**L-30 · ¿Qué pasa si el Banco Mercantil deja de operar el servicio o termina el contrato?** ¿Hay obligación de tener un segundo banco? (el ruteo ya está preparado, D-16).

## J. Lo que bloquea el desarrollo y lo que no

| Respuesta | Bloquea |
|---|---|
| L-01, L-02, L-04 | Salida a producción (T-03). El desarrollo y el sandbox siguen. |
| L-09, L-10 | El medio `wallet` (D-03): puede salir de la etapa 1. |
| L-22 | La emisión real de facturas de comisión; el cálculo y el detalle (P2.H2.M7) siguen. |
| L-16, L-25 | La política de retención y de borrado; mientras tanto, los registros no se borran. |
| Todo lo demás | Cambios de configuración o de contrato, sin frenar la construcción. |

## K. Respuestas recibidas

_Ninguna a la fecha. Esta sección se completa con cada respuesta: `L-nn` · fecha · quién · resumen · decisión o issue que provoca._
