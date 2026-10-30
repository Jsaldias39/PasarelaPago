# Perfil del QR de pay-qr (P4.H3.M3)

> **Estado: PROVISIONAL.** Este perfil NO es el del QR interoperable boliviano. Ese perfil no está publicado en una fuente que se haya
> podido verificar (`docs/spikes/banco-mercantil.md`; el BCB y el banco no resolvieron desde el entorno de trabajo). Un QR emitido
> con este perfil **no es interoperable todavía**. Se resuelve con Q-01 y Q-11.

## Qué se usa y de dónde sale cada dato

| Objeto EMV | Valor | Fuente / verificación |
|---|---|---|
| `00` Payload Format Indicator | `01` | EMV QRCPS-MPM; presente en los 12 payloads publicados de `test/fixtures/published-vectors.json` |
| `01` Point of Initiation | `11` estático, `12` dinámico | ídem (los vectores publicados traen `11` y `12`) |
| `26` Merchant Account Information | `00` = GUID configurable (`QR_ACCOUNT_GUID`), `01` = referencia del comercio (`mc_…`) | EMV deja el interior de las etiquetas 26 a 51 al operador. **El GUID real lo asigna el banco o el regulador: no se inventa**, es obligatorio y el servicio no arranca sin él |
| `52` Merchant Category Code | `0000` por defecto | `0000` (no informado) aparece en los payloads publicados; el MCC real (ISO 18245) lo informa el cliente |
| `53` Transaction Currency | `068` | ISO 4217: BOB = `068`, 2 decimales (verificado con el paquete `currency-codes` 2.2.0, MIT) |
| `54` Transaction Amount | decimal con punto, 2 decimales (`100.00`) | los payloads publicados escriben el monto así |
| `58` Country Code | `BO` | ISO 3166-1: `BO` = Bolivia (verificado con `Intl.DisplayNames`) |
| `59` / `60` Nombre y ciudad | ASCII, hasta 25 y 15 caracteres | límites de EMV; se quitan las tildes y se rechaza lo que no se pueda representar |
| `62/05` Reference Label | referencia de pago (`PQ…`, 16 caracteres) en dinámico; `***` en estático | `***` aparece en los payloads publicados para el estático |
| `63` CRC | CRC-16/CCITT-FALSE sobre todo el payload hasta `6304` | valor de comprobación `0x29B1` y 12 payloads publicados por terceros (autores independientes) |

**Fuentes de los payloads publicados:** `qrcode-pix` 5.0.0 (MIT), `pix-utils` 2.8.2 (MIT) y `emv-qrcps` 0.0.7 (ISC), extraídos de sus pruebas y
README (procedencia por entrada en `test/fixtures/published-vectors.json`). **No** son la especificación: el manual BR Code del Banco Central
de Brasil y la especificación de EMVCo no se pudieron consultar. Que el CRC coincida en 12 payloads de autores distintos demuestra el
algoritmo; no demuestra que el contenido de un QR boliviano sea correcto.

## Lo que NO está definido (no se inventa)

- El GUID y la estructura interna de la plantilla de cuenta del QR interoperable boliviano.
- Si el banco (o el BCB) exige campos adicionales (etiqueta `62` con subobjetos propios, plantillas de idioma alternativo `64`, etc.).
- Cómo el banco devuelve la referencia del pago en la notificación o en el extracto (decide el cruce con `62/05`).
- Vencimiento: EMV MPM no tiene un campo de vencimiento; el de pay-qr es de aplicación (`expires_at`) y no viaja en el QR.
