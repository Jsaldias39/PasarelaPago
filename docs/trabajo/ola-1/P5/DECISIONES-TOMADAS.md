# Decisiones tomadas sin confirmación — carril P5, ola 1

Supuestos que se tomaron para no detenerse. Cada uno dice a quién hay que confirmárselo. Sin valores de negocio inventados:
los números de pruebas son de prueba y están marcados como tales.

## pay-merchants

| ID | Decisión / supuesto | Confirmar con |
|---|---|---|
| D5-01 | **Los 18 puntos del alta legal** (3.1) se mapean: razón social, tipo societario, NIT y los 6 PDF (constitución, NIT, SEPREC, licencia, certificado SEDES, poder del representante) viven en `pay-merchants`; dirección, GPS central y de sucursales, gerentes y contactos viven en `directory` (M04) y se guardan como `directory_tenant_ref` opaco. **Pregunta escalada Q-22:** ¿`pay-merchants` referencia el `directory` o recaptura esos datos? | Stakeholder / dueño de `directory` |
| D5-02 | Para aprobar el KYC se exigen los 6 documentos y un nivel de riesgo (`low`/`medium`/`high`). | Cumplimiento |
| D5-03 | El NIT es único entre comercios no cerrados. | Negocio |
| D5-04 | El canal `direct` (7.9) no impone que su tasa sea menor que la de otros canales; se publica lo que se acuerde. | Negocio |
| D5-05 | Las claves `test` las pueden tener comercios `pending`/`active`; las `live`, solo `active`. Suspendido ⇒ `merchant_suspended`; cerrado ⇒ `forbidden`. | Producto |
| D5-06 | Gracia de rotación 24 h, tope 20 claves activas por comercio, documento KYC máximo 10 MiB. Son parámetros de arranque, no reglas. | Seguridad |
| D5-07 | Almacén de objetos de KYC: `FsObjectStore` es **[DEV]**; falta la implementación de producción (S3/MinIO con acceso autorizado y cifrado). | Infra (P1) |
| D5-08 | Versión 0 en `GET /merchants/me` = todavía no hay tarifario en vigencia. | P1 |
| D5-09 | Roles de operador propuestos (Q-21/Q-23) y llamador `pay-backoffice`. Sin verificador configurado, el back-office responde 401 (falla cerrado). | Identidad |
| D5-10 | Publicar un tarifario NO es idempotente por clave: cada POST crea una versión. `effective_from` pasado se rechaza (tolerancia 5 s). | P1 |
| D5-11 | Cerrar un comercio no revoca sus claves: los consumidores aplican `merchant.closed` (ver PR-07). | P1 / P3 |
| D5-12 | D-28 aplicado: el modo del llamador se lee de `X-Pay-Mode` (`test`\|`live`), nunca del cuerpo ni del token. | Coordinador |
| D5-13 | Hallazgo propio corregido: el almacén de idempotencia devuelve un error de negocio guardado como resultado; sin tratamiento, `POST /merchants` y `POST /api_keys` lo devolvían como 2xx al repetirse. Ahora se vuelve a lanzar como RFC 9457 (`src/idempotent.ts`, con prueba de regresión). | — |
