# Investigación — pasarelas de pago open source y estándares (2026-10-27)

> **Qué es:** el relevamiento que sostiene las decisiones de [`PLAN-MAESTRO.md`](./PLAN-MAESTRO.md) y [`DECISIONES.md`](./DECISIONES.md). Para cada
> proyecto: qué es, qué copiamos (código o patrón), qué descartamos y por qué.
> **Peldaño de evidencia:** `DISCOVERED` para lo relevado en este documento. Después se ejecutaron spikes con
> evidencia propia (ver [`../spikes/`](../spikes/)): **TigerBeetle y Temporal `TESTED`**, Watchman `TESTED` solo con
> datos de 2019, y card-vault, Svix, OpenBao y el Banco Mercantil `DISCOVERED`. Las licencias de la tabla se
> confirmaron leyendo el texto de cada `LICENSE` ([`../spikes/licencias.md`](../spikes/licencias.md)); no es asesoría legal. Cada licencia lleva
> su estado: `confirmada` (la fuente consultada la nombra) o `VERIFICAR` (hay que abrir el archivo
> `LICENSE` del repo antes de adoptarla).

## 1 · Proyectos relevados

### 1.1 Orquestadores y switches de pago

| Proyecto | Qué es | Licencia | Qué tomamos | Qué no |
|---|---|---|---|---|
| **juspay/hyperswitch** (Rust) | Switch de pagos open source: *router*, *scheduler* productor-consumidor sobre colas Redis, *drainer* (de Redis Streams a la base), analítica con Kafka + ClickHouse. Bóveda de tarjetas en un repo aparte (`hyperswitch-card-vault`), servicio de cifrado / gestor de claves propio y un *decision engine* externo que elige el conector con reglas de costo, volumen o datos. | Apache-2.0 · confirmada | **Patrones:** conector como interfaz única por proveedor; motor de ruteo separado del núcleo; la bóveda aislada para sacar al resto del sistema del alcance PCI; cifrado con gestor de claves propio. **Código:** `hyperswitch-card-vault`, como servicio desplegado tal cual, si se aceptan tarjetas con PAN propio (ola 3, opcional). | El núcleo en sí. Es Rust, y sus conectores se escriben dentro de su código. El equipo trabaja en NestJS y ya tiene código de pagos con tests. Hyperswitch orquesta pagos **para un comercio**: no trae un libro mayor de comercios ni liquida hacia ellos, que es justo lo que pide el stakeholder (7.4–7.9). |
| **mojaloop** (Node.js) | Hub de pagos interoperables entre proveedores (Fundación Gates), en microservicios: `central-ledger` (compensación, posiciones netas para liquidación diferida), `account-lookup-service` (a qué proveedor va el pago, con «oráculos» enchufables), `quoting-service` (comisiones antes de transferir) y `ml-api-adapter` (traduce la API pública al formato interno). | Apache-2.0 · confirmada (sitio de docs) | **Patrones:** cotizar antes de mover dinero; resolución de destinatario como servicio aparte; adaptador entre la API pública y el formato interno; compensación con posiciones netas y liquidación diferida. Es el modelo más parecido a lo que sería AloVida si fuera adquirente. | El hub entero: está pensado para un esquema nacional entre bancos, no para una plataforma con comercios. |
| **interledger/rafiki** (TypeScript) | Implementación de Interledger para entidades reguladas: API de administración, Open Payments, servidor de autorización GNAP, y TigerBeetle como contabilidad opcional. | VERIFICAR | **Patrones:** el mismo stack que el nuestro (TS + TigerBeetle) en producción; separar el servidor de autorización del de recursos. | Su documentación aclara que es **solo para entidades reguladas**. No resuelve nuestro problema. |
| **killbill/killbill** (Java) | Facturación por suscripción y pagos, modular, con un framework de plugins para pasarelas. | VERIFICAR | **Patrón:** plugin de pasarela con contrato estable; las funciones que no se usan se apagan. | El stack (JVM). La facturación ya vive en M17. |
| **getlago/lago** | Facturación por uso. | AGPL-3.0 · confirmada | Nada. | **Descartado por licencia:** la AGPL obliga a publicar las modificaciones de un servicio expuesto en red. |
| **jPOS** (Java) | Librería ISO 8583 (versiones 1987/1993/2003), ISO 20022 y EMV; jPTS es su switch comercial. | VERIFICAR (núcleo abierto + extensiones comerciales) | Referencia de mensajería ISO 8583 **si** algún día se conecta directo a un procesador de tarjetas. | Ahora no: Bolivia cobra mayormente por QR, y la tarjeta entra por el PSP. |

### 1.2 Libros mayores (ledger)

| Proyecto | Qué es | Licencia | Veredicto |
|---|---|---|---|
| **tigerbeetle/tigerbeetle** | Base de datos de partida doble: cuentas y transferencias con `id` de 128 bits elegido por el cliente, que sirve de clave de idempotencia; transferencias **en dos fases** (pendiente, después confirmada o anulada, con vencimiento); invariantes de saldo por cuenta (`debits_must_not_exceed_credits`); eventos enlazados atómicos. Jepsen la analizó en la versión 0.16.11. | Apache-2.0 · confirmada (texto del `LICENSE`, `docs/spikes/tigerbeetle.md` §6) | **Adoptado** como motor del servicio `pay-ledger`. Las dos fases son exactamente la **retención** de una autorización; el invariante de saldo impide gastar lo que no hay sin un `if` en la aplicación. Los metadatos (a qué factura corresponde, quién es el comercio) quedan en Postgres, no en TigerBeetle. |
| **formancehq/ledger** | Libro mayor programable con Numscript, un DSL para mover dinero. | 🔴 **No declarada** en `formancehq/ledger` v3; el repo anterior `formancehq/stack` es MIT solo para su Community Edition (`ee/` va con otra licencia). Ver `docs/spikes/licencias.md` | **Descartado** como ledger salvo confirmación escrita de su licencia (TigerBeetle pasó el spike). Numscript es un buen modelo para describir repartos (comisiones, splits). |
| **blnkfinance/blnk** | Libro mayor de partida doble orientado a billeteras y fintech. | Apache-2.0 · confirmada (`LICENSE.md`, sin el apéndice «How to apply»); una fuente de terceros menciona licencia dual para la nube | Segunda alternativa. |
| **Propio en Postgres** (`payments.wallet_ledger_entries`) | Ya existe en la API: *append-only* y bidireccional. | — | Se **recicla su semántica** (cuentas, asientos) como modelo de metadatos del ledger. |

### 1.3 Piezas de infraestructura

| Proyecto | Para qué | Licencia | Veredicto |
|---|---|---|---|
| **svix/svix-webhooks** (Rust) | Servidor de webhooks salientes: firma, reintentos, salud del endpoint. Requiere Postgres; Redis opcional. | MIT · confirmada (SDK y `server/`) | **Adoptado** detrás de `pay-webhooks`. No se escribe un motor de reintentos propio. |
| **Standard Webhooks** (especificación) | Cabeceras `webhook-id`, `webhook-timestamp` y `webhook-signature`; firma HMAC-SHA256 (`v1`, secreto `whsec_`) o Ed25519 (`v1a`); reintentos con *backoff* exponencial y *jitter* durante días; `410` deshabilita el endpoint. | Abierta | **Adoptada** como contrato de todo webhook que emitimos. |
| **Temporal** | Ejecución durable: sagas con compensaciones registradas por paso que corren en orden inverso. Su documentación pide compensaciones idempotentes. Hay ejemplos oficiales de *money transfer* y *order saga*. | MIT · confirmada (servidor y SDK TypeScript, `docs/spikes/temporal.md`) | **Adoptado** para orquestar el ciclo de un pago (autorizar → registrar en el ledger → capturar → notificar, con su vuelta atrás). |
| **Debezium Outbox Event Router** | Publica la tabla *outbox* en Kafka leyendo el WAL (con NATS se usa un relé propio por *polling* o `LISTEN/NOTIFY`); enruta por `aggregate_type`. Entrega **al menos una vez**. | Apache-2.0 · confirmada | **Patrón adoptado** (outbox + inbox). En la ola 1, relé por *polling*; Debezium es optativo en la ola 3. |
| **NATS JetStream** / Apache Kafka (KRaft) | Bus de eventos. | Apache-2.0 | **NATS JetStream elegido** (decisión D-10): un binario liviano que encaja en Coolify, con persistencia, *acks* y deduplicación por `Nats-Msg-Id`. Kafka queda como alternativa si la carga medida lo exige. Redpanda queda descartado porque su licencia es BSL. |
| **moov-io** (Go) | `ach`, `wire`, `fed` y **`watchman`**: búsqueda en listas de sanciones (OFAC, ONU, UE). | Apache-2.0 · confirmada (`ach` y `watchman`) | **Watchman adoptado** como servicio de cribado dentro de `pay-risk`. ACH y Fedwire no aplican en Bolivia. |
| **OpenBao** | Secretos y KMS, bifurcación de Vault con licencia MPL. | MPL-2.0 · confirmada: copyleft por archivo (solo obliga si se modifican archivos de OpenBao) | **Adoptado** para claves de firma, secretos de conectores y cifrado de campos. HashiCorp Vault se descarta por su licencia BSL. |
| **hyperswitch-card-vault** | Bóveda PCI de PAN. | Apache-2.0 · confirmada (repo de Juspay) | Ola 3, **solo si** se decide aceptar tarjeta con PAN propio. Antes de eso, la tarjeta entra por los campos alojados del PSP y el PAN nunca pasa por nosotros. |

## 2 · Estándares que el diseño adopta

| Tema | Estándar | Cómo se aplica |
|---|---|---|
| Dinero | ISO 4217, unidades menores enteras | `amount_minor: int64` + `currency`. Nunca `float`. Se recicla `payment-money.ts` de la API. |
| API pública | OpenAPI 3.1, orientada a recursos (estilo Stripe) | `/v1/payment_intents`, `/v1/refunds`… Versión en la URI y cambios solo aditivos dentro de `v1`. |
| Errores | RFC 9457 *Problem Details* | `type`, `title`, `status`, `detail` y un `code` estable que el cliente distingue. |
| Idempotencia | Cabecera `Idempotency-Key` (borrador IETF *httpapi*) + diseño de **fases atómicas y puntos de recuperación** (Brandur, «Stripe-like idempotency keys in Postgres») | La clave se reclama con un único `INSERT` con restricción única, nunca con «leer y después escribir». Se guarda la respuesta y se devuelve igual en los reintentos. Horizonte de 24 h. |
| Eventos internos | CloudEvents 1.0 + AsyncAPI 3.0 | Sobre común; un *topic* por agregado. |
| Webhooks salientes | Standard Webhooks v1 | Firma `v1` HMAC por defecto, `v1a` Ed25519 a pedido del comercio. |
| Entrega de mensajes | Outbox / inbox, al menos una vez | Todo consumidor guarda el `event_id` procesado **en la misma transacción** que su efecto. |
| Consistencia entre servicios | Saga orquestada (Temporal) | Cada paso tiene su compensación idempotente. No hay transacciones distribuidas (2PC). |
| Contabilidad | Partida doble, inmutable, retenciones en dos fases | Los errores se corrigen con asientos inversos, nunca con `UPDATE` ni `DELETE`. |
| QR | EMVCo QRCPS *Merchant-Presented Mode* | Formato TLV: empieza con `000201` y termina con `6304` + CRC16. Plantillas de cuenta del comercio en los IDs 26 a 51, con su GUID en el subcampo `00`. El perfil boliviano se ajusta al QR interoperable del BCB. |
| Conciliación bancaria | ISO 20022 `camt.053` / `camt.054` | Formato de entrada de extractos cuando el banco lo ofrezca; si no, CSV por conector. |
| Tarjetas | PCI DSS v4.0.1, la única versión vigente desde el 31-03-2025 | **Minimizar el alcance:** campos alojados del PSP (alcance tipo SAQ A) antes que una bóveda propia. |
| Seguridad API | OWASP API Security Top 10:2023, ASVS 5.0 | Autorización por objeto (BOLA) en cada recurso de comercio; *rate limit*; mTLS entre servicios. |
| Observabilidad | OpenTelemetry | La API ya usa OTel + pino: se reutiliza la misma configuración. |
| Regulación Bolivia | BCB, *Reglamento de Servicios de Pago, Instrumentos Electrónicos de Pago, Compensación y Liquidación* (RD 079/2022); pasarelas como canal de pago (RD 069/2021); QR interoperable desde RD 137/2019 | **VERIFICAR con asesoría legal.** Un análisis de 2023 decía que las pasarelas no necesitaban autorización de ASFI; puede haber cambiado. Procesar y liquidar hacia comercios es otra cosa (ver issue #122). |

## 3 · Conclusiones que pasan al plan

1. **No hace falta escribir ni el motor de reintentos, ni el libro mayor, ni la bóveda.** Se
   adoptan Svix, TigerBeetle y (opcional) `hyperswitch-card-vault`, y el trabajo propio se
   concentra en lo que ningún proyecto trae: **conectores bolivianos, comisiones por acuerdo,
   liquidación a comercios y pagos programados** (7.3, 7.7, 7.8 y 7.9).
2. **El código que ya existe se recicla.** En `mantra-core-health-api`:
   `payment-money.ts` (215 líneas), `payment-callback-machine.ts` (112, que decide si un callback
   es `aplicar | duplicado | obsoleto | contradiccion`), `webhook-secret.resolver.ts`,
   `callback-endpoint.policy.ts` y `wallets.service.ts`, con sus specs. Pasan a librerías de
   `pay-contracts` sin reescribirse.
3. **La arquitectura copia la separación de Hyperswitch** (núcleo, conectores, ruteo, bóveda y
   cifrado como piezas distintas) **y la de Mojaloop** (cotizar, resolver destinatario, ledger
   de compensación).

## Fuentes

- Hyperswitch: [repo](https://github.com/juspay/hyperswitch) · [componentes (academy)](https://academy.hyperswitch.io/chapter-1-getting-started-with-self-hosted-hyperswitch/1.2-overview-of-hyperswitch-core-components) · [docs](https://docs.hyperswitch.io/llms.txt)
- Mojaloop: [visión técnica](https://docs.mojaloop.io/technical/overview/) · [project](https://github.com/mojaloop/project) · [account lookup](https://docs.mojaloop.io/legacy/mojaloop-technical-overview/account-lookup-service/)
- Rafiki: [overview](https://rafiki.dev/introduction/overview) · [integración con TigerBeetle](https://interledger.org/developers/blog/rafiki-tigerbeetle-integration/)
- TigerBeetle: [two-phase transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/) · [transfer](https://docs.tigerbeetle.com/reference/transfer) · [análisis Jepsen 0.16.11](https://jepsen.io/analyses/tigerbeetle-0.16.11)
- Formance: [stack](https://github.com/formancehq/stack) · [pkg.go.dev](https://pkg.go.dev/github.com/formancehq/ledger) · Blnk: [docs](https://www.mintlify.com/blnkfinance/blnk/introduction)
- Svix: [servidor open source](https://www.svix.com/open-source-webhook-service) · Standard Webhooks: [spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
- Temporal: [saga pattern](https://docs.temporal.io/design-patterns/saga-pattern.md) · [ejemplos](https://learn.temporal.io/examples/)
- Outbox: [Conduktor](https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing) · [Debezium outbox (RisingWave)](https://risingwave.com/blog/debezium-outbox-pattern-guide/)
- Idempotencia: [Brandur](https://brandur.org/idempotency-keys)
- moov-io: [ach](https://pkg.go.dev/github.com/moov-io/ach/docs) · Kill Bill: [README](https://cdn.jsdelivr.net/gh/killbill/killbill@master/README.md) · Lago: [repo](https://Github.com/getlago/lago) · jPOS: [jpos.org](https://jpos.org)
- PCI DSS v4.0.1: [usd.de](https://www.usd.de/en/pci-dss-future-dated-requirements/) · [Bright Defense](https://www.brightdefense.com/news/pci-dss-v4-0-1-sets-new-baseline-for-cardholder-data-security/)
- EMVCo QR: [BR Code (BCB Brasil)](https://www.bcb.gov.br/content/estabilidadefinanceira/spb_docs/ManualBRCode.pdf) · [NepalPay QR](https://doc.connectips.com/docs/NepalPAY-QR/NEPALPAY%20API%20Specification/QR%20Code%20Specification)
- Bolivia: [BCB — Sistema de pagos 2023](https://www.bcb.gob.bo/webdocs/publicacionesbcb/2024/03/07/SISTEMA%20DE%20PAGOS%202023vf.pdf) · [ASFI — uso del QR](https://www.asfi.gob.bo/sites/default/files/2025-07/El%20uso%20del%20QR%20ha%20dinamizado%20el%20sistema%20de%20pagos%20en%20Bolivia.pdf) · [EMBA — reglamento de servicios de pago](https://emba.com.bo/regulacion-de-pasarelas-de-pago-nuevo-reglamento-de-servicios-de-pago-instrumentos-electronicos-de-pago-compensacion-y-liquidacion/) · [Internet Bolivia — regulación de pagos digitales](https://internetbolivia.org/wp-content/uploads/2023/06/E-commerce-y-la-regulacion-de-pagos-digitales-en-Bolivia.pdf)
