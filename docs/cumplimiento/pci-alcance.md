# Mapa de alcance PCI DSS v4.0.1 · P1.H4.M1

> Dueño: **P1** · Revisión pendiente de **P3** (dueño de `pay-vault`) y de un **QSA** (D-13: la certificación es un objetivo, no existe hoy).
> Peldaño: `WRITTEN` — es un documento de análisis sobre el diseño y los contratos del repo; **ningún control de red ni de
> despliegue de producción existe todavía**, y nada de esto fue auditado. Lo que sí tiene prueba se enlaza en «Evidencia que ya existe».

## 1. Qué se afirma y qué no

- Este documento clasifica **cada servicio** según su relación con los datos de tarjeta y dice **por qué**, con la ruta del
  contrato o del código que lo respalda.
- **No es una opinión de QSA.** Las clasificaciones son el supuesto de diseño que el QSA tiene que confirmar. Donde el diseño
  todavía no decidió algo, está en la sección 6 («Decisiones abiertas») y la clasificación afectada dice «provisoria».
- Términos del estándar usados: **sistemas del CDE** (almacenan, procesan o transmiten datos de titular de tarjeta o datos
  sensibles de autenticación), **sistemas conectados o que impactan la seguridad** del CDE (también están en alcance) y
  **fuera de alcance** (sin conectividad con el CDE y sin acceso a datos de tarjeta).

## 2. Principio de diseño que define el alcance

1. **El PAN solo existe en `pay-vault`** (`CLAUDE.md` regla 6; `docs/plan/PLAN-MAESTRO.md` §3.2 regla 7). Nunca en logs, trazas, eventos, errores ni otra base.
2. **La API pública no tiene ningún campo para el número de tarjeta**: solo `card_token` («Token del PSP o de `pay-vault`. NUNCA el número de tarjeta», `contracts/openapi/public-v1.yaml`). El PAN entra por la **captura alojada** (`contracts/openapi/internal-vault-v1.yaml`, `capture_sessions`) o por la página de pago del banco, **sin pasar por `pay-edge` ni `pay-payments`**.
3. **Por defecto la tarjeta ni siquiera nos toca**: D-17 dice que se cobra por la adquirencia del Banco Mercantil Santa Cruz y T-02 fija que, mientras no se resuelva, se usan los campos alojados del PSP. `pay-vault` existe para cuando un comercio quiere **guardar** la tarjeta.
4. **Segmentación**: `pay-vault` vive en una red de Coolify aislada, alcanzable solo por `pay-payments` y `pay-connectors` (D-09; `internal-vault-v1.yaml`; prueba pendiente en P1.H4.M3).

## 3. Clasificación por servicio

| Servicio | Dueño | Clasificación | Por qué | Evidencia / respaldo |
|---|---|---|---|---|
| `pay-vault` | P3 | **CDE** | Guarda el PAN (tokeniza) y es el único que lo entrega (`reveal`). | `internal-vault-v1.yaml`; spike `docs/spikes/card-vault.md` (solo documental) |
| `pay-connectors` | P4 | **CDE (provisoria)** | Es el único autorizado a llamar a `reveal` y a enviar la tarjeta al proveedor: el PAN **transita su memoria**. Pasaría a *conectado* solo si el diseño cambia a «la bóveda reenvía al proveedor» (decisión abierta A). | `internal-vault-v1.yaml` (`x-open-question` de `reveal`) |
| `pay-payments` | P3 | **Conectado al CDE / impacta la seguridad** | Nunca recibe el PAN (opera con `card_token`), pero abre sesiones de captura y es uno de los dos servicios con acceso a la red del CDE. | `internal-vault-v1.yaml` («`pay-payments` jamás recibe un número de tarjeta») |
| `pay-edge` | P1 | **Fuera de alcance, con controles que lo sostienen** | Enruta bytes de la API pública, donde no existe ningún campo de tarjeta; **no tiene ruta de red a `pay-vault`** (a demostrar en P1.H4.M3). Como el borde reenvía cuerpos sin interpretarlos, un cliente podría mandar un PAN por error: el borde lo **rechaza antes de reenviar** (422 `card_number_detected`) y no lo registra. Inspecciona **cada token** del JSON ya decodificado (escapes `\uXXXX`, claves duplicadas, corridas de separadores de cualquier longitud y mezcla, dígitos de ancho completo, anidado en objetos y listas, como número), y un JSON que no se puede interpretar también se rechaza (422 `invalid_json`). | `services/pay-edge/src/proxy/pan-guard.ts`; `services/pay-edge/test/pan-guard.spec.ts` (120 pruebas en tres niveles) |
| `pay-webhooks` | P1 | **Fuera de alcance** | Entrega eventos públicos con política de payload «solo ids, estados e importes»; un evento con tarjeta, correo o teléfono en un valor se **rechaza**. Sin acceso al CDE. | `services/pay-webhooks/src/events/payload-policy.ts`; `test/payload-policy.spec.ts` |
| `pay-ledger` | P2 | **Fuera de alcance** | Solo montos y cuentas. Sin datos de tarjeta. | `contracts/asyncapi/ledger-settlement.yaml` (`x-pii: none`) |
| `pay-settlement` | P2 | **Fuera de alcance** | Cortes, payouts y conciliación. Sin datos de tarjeta. **Provisoria**: los extractos del banco (`camt.053`/CSV) pueden traer PAN enmascarado; confirmar con el banco que nunca llega completo. | pregunta B en §6 |
| `pay-merchants` | P5 | **Fuera de alcance** | Datos del comercio (KYC), no del pagador. `api_key.created` lleva solo el hash y `last4` de la clave de API, que **no** es un dato de tarjeta. | `contracts/asyncapi/merchants-schedules.yaml` |
| `pay-risk` | P5 | **Fuera de alcance** | Reglas y cribado de sanciones sobre el comercio y el pagador; sin tarjeta. **Provisoria**: confirmar que las señales de riesgo por tarjeta usan solo el token o el BIN, nunca el PAN. | pregunta C en §6 |
| `pay-schedules` | P5 | **Fuera de alcance** | Mandatos y pagos programados sobre montos y referencias; el medio de pago es un `card_token`. | `merchants-schedules.yaml` |
| `pay-qr` | P4 | **Fuera de alcance** | Genera QR EMVCo (no es dato de tarjeta). | — |
| `pay-mockbank` | P4 | **Fuera de alcance (solo sandbox)** | No arranca con `PAY_MODE=live` (D-26). Procesa números de tarjeta **de prueba** de las marcas. | `docs/plan/PLAN-MAESTRO.md` §3.1 |
| Plataforma (Postgres, NATS, Redis, Temporal, TigerBeetle, OpenBao, Jaeger) | P1 | **Fuera de alcance, salvo lo que aloje al CDE** | NATS/Redis/Jaeger no deben ver nunca un PAN (los eventos llevan `x-pii: none`; las trazas no llevan cuerpos). El Postgres **de `pay-vault`** y la instancia de **OpenBao que guarda sus claves** son del CDE: tienen que ser instancias propias, no las compartidas. | `platform/compose.yml`; decisión abierta D |

**Regla para toda clasificación nueva:** un servicio pasa a estar *en alcance* en cuanto (a) recibe, guarda o transmite un PAN o un CVV,
(b) tiene ruta de red al CDE, o (c) administra los controles de seguridad del CDE. Cualquier cambio de contrato que agregue un campo de
tarjeta fuera de `pay-vault` es un cambio de alcance y exige actualizar este documento en el mismo PR.

## 4. Los doce requisitos de PCI DSS v4.0.1, contra este diseño

Estado: **Diseño** (decidido, sin implementar o sin prueba) · **Parcial** (hay código o prueba de una parte) · **Falta** (nada todavía).
Todo lo que dice «Diseño» o «Falta» es trabajo de las olas 2 y 3 (`docs/plan/PLAN-MAESTRO.md` §5.1) y de despliegue.

| # | Requisito | Qué lo cubre en este diseño | Estado | Qué falta |
|---|---|---|---|---|
| 1 | Instalar y mantener controles de seguridad de red | Red de Coolify aislada para el CDE; `pay-edge` sin ruta a `pay-vault`; mTLS + `X-Service-Id` entre servicios (`@pay/service-auth`, regla de separación 8). | Parcial | Demostrar la segmentación con la prueba de P1.H4.M3 (desde `pay-edge` falla, desde `pay-payments` funciona). El guard de identidad por cabecera **no** reemplaza al certificado mTLS (límite declarado en `contracts/packages/service-auth/src/index.ts`). |
| 2 | Configuraciones seguras de todos los componentes | Configuración validada al arrancar, sin valores por defecto para secretos (regla 90.3.4); imágenes mínimas por servicio. | Parcial | Línea base de endurecimiento de los hosts de Coolify y de las imágenes del CDE; inventario de componentes. |
| 3 | Proteger los datos de cuenta almacenados | PAN solo en `pay-vault`, cifrado con claves de OpenBao; CVV **nunca** se guarda (SAD); sin PAN en otras bases ni eventos. | Diseño | Elegir bóveda (decisión abierta A y E), política de retención y borrado (`DELETE token`), gestión y rotación de claves de cifrado. |
| 4 | Proteger el PAN con criptografía fuerte en redes abiertas | TLS hacia el banco y hacia el pagador; mTLS interno; el PAN no viaja por `pay-edge`. | Diseño | Versiones y suites de TLS verificadas en cada borde; certificados del banco. |
| 5 | Proteger contra malware | — | Falta | Antimalware/EDR en los hosts del CDE; análisis de imágenes en CI. |
| 6 | Desarrollar y mantener sistemas y software seguros | Revisión de código, pruebas de autorización negativa y de separación en cada servicio (gates del PLAN-MAESTRO §7); `pay-edge` rechaza PAN (defensa en profundidad); SSRF bloqueado en webhooks (`pay-webhooks/src/ssrf`); lockfile commiteado. | Parcial | Escaneo de dependencias y de secretos en CI (hoy el CI propio está caído y los `check-*.mjs` se corren a mano); inventario de software; gestión de parches; **6.4.3 / 11.6.1** (guiones y cabeceras de la página de pago) si la captura alojada la sirve la bóveda. |
| 7 | Restringir el acceso por necesidad de saber | Solo `pay-payments` y `pay-connectors` llegan a `pay-vault`; `reveal` solo para `pay-connectors`; autorización por servicio con `@AllowedServices`. | Parcial | Procedimiento de altas/bajas de personas con acceso al CDE; revisión periódica de accesos. |
| 8 | Identificar usuarios y autenticar el acceso | Claves de API con hash que liga modo+id+secreto (D-27/D-28); secretos de firma sellados con AES-256-GCM. | Parcial | Autenticación fuerte (MFA) de las personas administradoras del CDE y de Coolify/OpenBao; cuentas individuales, sin compartidas. |
| 9 | Restringir el acceso físico | Delegado en el proveedor de hosting del CDE. | Falta | Elegir proveedor y obtener su Atestación de Cumplimiento (AOC). |
| 10 | Registrar y monitorear todos los accesos | Logs con `request_id`, redacción de credenciales, sin PAN ni datos personales (regla 90.2); auditoría de lecturas en `reveal`. | Parcial | Registro centralizado, sincronía de reloj, retención de 12 meses, alertas sobre accesos al CDE; que `reveal` deje rastro por llamada. |
| 11 | Probar la seguridad regularmente | Pruebas de autorización negativa, separación (REQ-P1-7) y SSRF; prueba de carga de la ola 3. | Parcial | Escaneos de vulnerabilidades internos y externos (ASV), prueba de penetración de segmentación, detección de cambios en la página de pago. |
| 12 | Políticas y programas de seguridad de la información | Este documento, el cuestionario legal y las reglas de la casa. | Falta | Política formal, programa de concientización, plan de respuesta a incidentes, gestión de proveedores de servicio (Banco Mercantil, hosting): solicitar sus AOC. |

## 5. Evidencia que ya existe

| Afirmación | Dónde se prueba |
|---|---|
| Un cuerpo con un PAN no atraviesa `pay-edge`, aunque venga con escapes, separadores o anidado (422, sin repetir el número, sin llegar al servicio ni a la salida estándar) | `services/pay-edge/test/pan-guard.spec.ts` |
| Ningún payload de webhook lleva tarjeta, correo ni teléfono; un evento con esos datos se rechaza | `services/pay-webhooks/test/payload-policy.spec.ts` (80 pruebas, incluye el *grep* del DoD sobre los 21 eventos públicos) |
| Los secretos de firma de webhooks no están en claro en la base ni en la tabla de idempotencia | `services/pay-webhooks/test/endpoints.spec.ts` («secretos: nunca en claro») |
| `pay-edge` no deja pasar cabeceras de identidad ni de modo del cliente | `services/pay-edge/test/authz.spec.ts` |
| Los contratos públicos solo hablan de `card_token` | `contracts/openapi/public-v1.yaml` |

**Límites declarados del guardia del borde:** no detecta un PAN partido en varios campos ni codificado (base64, hexadecimal); y una cadena
numérica de 13 a 19 dígitos que case con Luhn por casualidad (≈ 1 de cada 10) se rechaza aunque no sea una tarjeta, por ejemplo una
referencia propia del comercio: el mensaje de error le dice que use un token.

## 6. Decisiones abiertas que cambian el alcance

| ID | Pregunta | Quién decide | Efecto sobre el alcance |
|---|---|---|---|
| A | ¿`pay-vault` **reenvía** la tarjeta al proveedor (proxy) o la **devuelve** a `pay-connectors` (`reveal`)? | Equipo de seguridad + QSA (P3 y P4) | Si reenvía, `pay-connectors` deja de ser CDE y pasa a conectado. Si devuelve, el PAN transita por `pay-connectors`. |
| B | ¿Los extractos del banco (conciliación) pueden traer PAN completo? | Banco Mercantil (a pedir) | Si sí, `pay-settlement` entra al alcance. |
| C | ¿`pay-risk` usa solo token/BIN? | P5 | Si usa PAN, entra al alcance. |
| D | ¿El Postgres y el OpenBao de `pay-vault` son instancias propias? | P1 + P3 | Si se comparten con otros servicios, **todos** pasan a estar en alcance. |
| E | ¿Quién aloja el formulario de captura: el banco o la bóveda? | Banco (a pedir) + P3 | Define si el cuestionario objetivo es **SAQ A** (todo alojado por el banco) o uno mucho más pesado (**SAQ D**). Es la decisión que más reduce el esfuerzo de certificación; los criterios de elegibilidad de cada SAQ los confirma el QSA contra la versión vigente. |
| F | ¿Los comercios guardan tarjetas (tokens persistentes) en la etapa 1? | Dueño del proyecto | Sin tarjetas guardadas, `pay-vault` puede quedar sin usarse y el CDE propio se reduce a ninguno (T-02). |

## 7. Cómo mantener este documento

- Todo servicio nuevo figura acá **antes** de cerrar su ola 3 (gate «PCI» del PLAN-MAESTRO §7).
- Todo PR que agregue un campo con datos de tarjeta, un endpoint hacia `pay-vault` o una dependencia de red hacia el CDE actualiza la
  tabla de la sección 3 en el mismo PR.
- La revisión del QSA se registra acá con fecha; hasta entonces, el encabezado dice «Revisión pendiente».
