> Peldaño: DISCOVERED (solo fuentes públicas, vistas por buscador) · Veredicto: NO (no hay documentación pública de API; hay que pedirla al banco)

# Spike — Banco Mercantil Santa Cruz (BMSC): qué es público y qué hay que pedirle · P4.H1.M1

Fecha: 2026-10-27 · Servicios afectados: `pay-connectors` (adaptadores Mercantil QR y tarjeta), `pay-qr`, `pay-settlement` (extractos) · Decisión: D-16.

## Pregunta

¿Qué documentación pública existe del BMSC para cobro por QR interoperable, adquirencia/pasarela de
tarjetas para comercios, API de cuenta empresarial/extractos y ambiente de pruebas?

## Qué se hizo

Seis búsquedas web (QR de cobro, pasarela/adquirencia, banca empresarial/extractos, QR interoperable,
cobranza/botón de pago de `bmsc.com.bo` y `$imple`) y dos intentos de abrir fuentes oficiales con `WebFetch`:

```text
WebFetch https://www.bmsc.com.bo               -> getaddrinfo ENOTFOUND www.bmsc.com.bo
WebFetch https://apps.apple.com/.../bmsc-móvil -> getaddrinfo ENOTFOUND apps.apple.com
```

**Limitación importante:** desde este entorno **no resuelven** ni el sitio del banco ni la tienda de
aplicaciones. Todo lo que sigue sobre el BMSC viene de resúmenes de buscador, no de haber leído la página
oficial. Ningún PDF regulatorio se abrió: se citan por lo que mostró el buscador.

## Hallazgos

### Cuidado con las homónimas

- El «Portal API – Mercantil Banco» (<https://apiportal.mercantilbanco.com/>) y su producto «Pagos Móviles C2P» son de **Mercantil Banco, Venezuela**. **No son del BMSC** y no se usan como evidencia.
- «Banco Santa Cruz» (bancosantacruz.com: botón de pago, «cobra con QR») es **otra entidad**.
- bmsc24.es es una tienda de España.

### Tabla por tema

| Tema | Clasificación | Qué se encontró |
|---|---|---|
| **API de cobro QR para comercios del BMSC** | **No encontrado → pedirlo al banco** | Ninguna página, portal ni documento técnico del BMSC. |
| QR de cobro como producto | Público, **no verificado en la fuente** | Según el buscador, la ficha de la app *BMSC Móvil* (App Store / Google Play) dice que genera QR de cobro con vigencia de hasta 365 días y que tiene «Colectas» (un QR para cobros grupales). Un resultado de YouTube se titula «¡Ahora cobro con QR! Genera un usuario de cobranza» (no verifiqué que sea del banco). Sugiere que el cobro por QR se gestiona por la banca del banco, no por una API abierta. Fuentes: <https://play.google.com/store/apps/details?id=bo.com.bmsc.bancamovil&hl=en_US> · <https://www.youtube.com/watch?v=6x8jHgoc7SM> |
| Adquirencia / pasarela de tarjetas para comercios | **No encontrado → pedirlo al banco** | Sin resultados del BMSC. Aparecen solo páginas genéricas y de otros bancos. |
| Cuenta empresarial: extractos, conciliación, archivos (`camt.053`/CSV), host-to-host | **No encontrado → pedirlo al banco** | Sin resultados del BMSC. |
| Ambiente de pruebas (*sandbox*) | **No encontrado → pedirlo al banco** | Sin resultados del BMSC. |
| Base regulatoria del QR interoperable | Público y citado (resumen de buscador) | QR oficializado como instrumento de pago en 2019 (RD BCB 137/2019); el BCB lo describe como estándar interoperable obligatorio para el sistema financiero y la ASFI supervisa el cumplimiento; reglamento vigente de Servicios de Pago, RD 079/2022. Fuentes: <https://www.asfi.gob.bo/sites/default/files/2025-07/El%20uso%20del%20QR%20ha%20dinamizado%20el%20sistema%20de%20pagos%20en%20Bolivia.pdf> · <https://www.bcb.gob.bo/webdocs/files_noticias/NP%20QR%20BCB.pdf> · <https://emba.com.bo/regulacion-de-pasarelas-de-pago-nuevo-reglamento-de-servicios-de-pago-instrumentos-electronicos-de-pago-compensacion-y-liquidacion/> |
| Contenido de un QR de cobro | Público, descripción de usuario | La ASFI describe que la app del receptor genera el código con monto, titular, cuenta o teléfono, entidad financiera y vencimiento opcional. **No es una especificación técnica**: no hay formato de datos ni verificación de integridad. |
| Especificación técnica del QR interoperable (`$imple` / «QR SIMPLE», ASOBAN) y API de bancos | **No encontrado → pedirlo a ASOBAN / BCB / al banco** | Sólo notas de prensa. El operador de la plataforma aparece como ACCL en una fuente y como Red Enlace en un blog de baja autoridad (sin verificar): hay que aclararlo. |
| QR de otro sistema (QR BCB BOLIVIA, lanzado en diciembre de 2022) | Público (resumen) | Existe como alternativa; **falta saber cuál de los dos QR usa el cobro del BMSC**. |

## Lista de pedido al banco (sin suponer nada que no esté publicado)

**Comercial y legal**
1. Producto y contrato para una **empresa que cobra por cuenta de terceros** (recaudadora): condiciones, tarifas, límites y quién responde por cada riesgo. Que el banco confirme por escrito si ese esquema encaja en su oferta.
2. Requisitos de afiliación y de KYC/diligencia del banco hacia nosotros y hacia los comercios a los que luego se les liquida.
3. Confirmación del banco de qué reglas del BCB (RD 079/2022 y las vigentes) le aplican a este esquema desde su lado.

**QR interoperable**
4. Documentación técnica de **emisión de QR dinámico** (monto fijo, referencia, vencimiento) y de **QR estático**: formato, firma o verificación, y límites.
5. Cuál de los QR admite el banco (`$imple`/QR SIMPLE y/o QR BCB) y cuál es el que paga una app de otro banco.
6. **Notificación del pago**: si el banco avisa por *callback* (¿firmado?, ¿con reintentos?) o solo hay consulta; método de **consulta de estado**; **reversos y devoluciones**.
7. Referencia única que viaja de punta a punta para conciliar (qué campo del banco devuelve nuestra referencia).

**Tarjetas**
8. Si el banco ofrece **adquirencia en línea** a una plataforma: documentación del producto, pasarela o página de pago, tokenización, autorización/captura/anulación/reembolso, 3-D Secure, contracargos y plazos.
9. Marcas aceptadas, tarifas e informe de cumplimiento PCI que el banco exige a quien integra.

**Cuenta recaudadora y extractos**
10. Formato y canal de **extractos** (¿`camt.053`, CSV, archivo por canal host-to-host, API?), frecuencia, huso horario y corte diario.
11. Manera de **pagar a terceros desde la cuenta** (transferencias masivas / pagos a proveedores): formato de lote, límites, confirmación y rechazos.
12. Cómo se identifica quién pagó (campos disponibles en el extracto).

**Ambientes y seguridad**
13. **Ambiente de pruebas** con credenciales de prueba, datos de ejemplo y casos de error documentados; y el proceso de paso a producción.
14. Mecanismos de seguridad del canal: autenticación, firma o cifrado de mensajes, listas de IP permitidas, rotación de credenciales.
15. Contactos técnicos, soporte y ventanas de mantenimiento.

## Veredicto: NO (documentación pública) · decisión sobre el plan

No existe, en lo que pude ver, documentación pública de API del BMSC. Por eso el plan mantiene:
simulador de P4 como conector de las olas 1 y 2, y los adaptadores `Mercantil · QR` y `Mercantil · tarjeta`
(P4.H2.M3/M4) condicionados a recibir la documentación y el ambiente de pruebas pedidos arriba.
Los campos, rutas y mensajes de esos adaptadores **no deben escribirse antes** de tener el documento del banco.

## No cubierto

Sitio oficial del banco, fichas de las tiendas de aplicaciones (no se pudieron abrir), PDF del BCB y de la ASFI (solo vistos por buscador), ASOBAN, sucursal virtual de empresas, tarifas y cualquier contrato.
