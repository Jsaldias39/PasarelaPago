# mTLS entre servicios · análisis para la decisión del dueño de arquitectura · P1.H2.M3

> **Este documento NO decide.** No hay código de mTLS en el repo y no se escribió ninguno. Reúne qué hace hoy la identidad entre servicios, qué le agregaría cada opción, su costo y su
> riesgo, y una lectura con la que el dueño puede discrepar. Lo que no pude comprobar está marcado.

## 1 · Qué hace hoy la identidad entre servicios

**Mecanismo:** `@pay/service-auth` (`contracts/packages/service-auth/src/index.ts`). Cada cliente interno manda `X-Service-Id: pay-<nombre>` (`serviceHeaders`) y el servidor receptor
instala `ServiceIdentityGuard` (por ejemplo `services/pay-risk/src/app.module.ts:46`): la cabecera tiene que existir, tener la forma `^pay-[a-z]+$` y estar en la lista
`@AllowedServices(...)` de la ruta. Una ruta sin lista responde 403 (seguro por defecto); `@PublicRoute()` exime la salud y los callbacks firmados. Los demás datos de contexto
(`x-merchant-id`, `x-pay-mode`, `idempotency-key`) viajan también como cabeceras.

**Qué garantiza:**
- Contra errores de cableado: un servicio no puede llamar por accidente a una ruta que no lo lista, y una ruta nueva nace cerrada.
- Documenta y hace cumplir el grafo de llamadas permitido (quién puede llamar a quién) en cada servidor.

**Qué NO garantiza** (el propio guard lo dice: «LÍMITE CONOCIDO … NO es una barrera suficiente por sí solo fuera de una red con mTLS»):
- **La cabecera es una cadena sin firma.** Cualquiera que alcance el puerto del servicio puede escribir `x-service-id: pay-payments` y pasar el guard. La prueba E7 lo ejerce a diario sin
  quererlo: `e2e/flows/e7.e2e.ts` «hace de pay-connectors» con `callAs('pay-connectors', 'pay-vault', …/reveal)` y obtiene el número de tarjeta (sintético) de la bóveda; el único control
  que se interpuso fue que la lista de la ruta incluía a `pay-connectors`.
- **Lo mismo vale para `x-merchant-id` y `x-pay-mode`**: quien se hace pasar por `pay-edge` puede elegir el comercio y el modo (`live`) que quiera. El D-28 («el modo lo fija `pay-edge`
  desde el registro de la clave») solo se sostiene si nadie más puede hablarle a los servicios.
- No cifra el canal: el tráfico interno va en HTTP claro (los servicios del arnés y del Compose escuchan `http://`). Entre otras cosas viaja el cuerpo de `reveal`, que devuelve el PAN
  (`e7.e2e.ts`; hoy `pay-connectors` no llama a la bóveda — hallazgo 15 del arnés —, pero el contrato lo permite).
- No hay en el repo ningún proxy ni malla que «termine el certificado y lo mapee a `X-Service-Id`», que es lo que el comentario del guard presupone. `platform/compose.yml` define una sola
  red (sin `networks:`), y la segmentación de `pay-vault` (P1.H4.M3) está en `TODO`.

**Resumen:** frente a un atacante con acceso a la red interna, hoy la identidad de servicio **no es una barrera**: es un contrato de buena fe que asume que el perímetro de red ya la protege,
y ese perímetro todavía no existe como control demostrado.

## 2 · Modelos de atacante (qué cambia con cada opción)

| Atacante | Hoy (cabecera) | Segmentación de red | Segmentación + identidad firmada | mTLS en aplicación |
|---|---|---|---|---|
| Sin acceso a la red interna | detenido por el perímetro | igual | igual | igual |
| Con alcance de red pero sin credenciales (contenedor lateral, SSRF desde un servicio que hace salidas como `pay-webhooks`, un invitado en la red de Coolify) | **suplanta a cualquier servicio** | solo llega a lo que la red le permite (pero ahí suplanta) | no puede firmar: detenido | no tiene certificado: detenido (el handshake falla antes del guard) |
| Servicio comprometido (tiene sus propias credenciales) | hace lo que ese servicio puede y además se hace pasar por otro | contenido por la red | hace lo que ese servicio puede, hasta que se revoque o rote su clave | igual que la firmada; la clave privada vive en ese proceso |
| Escucha pasiva en la red interna | lee todo | lee todo lo que llegue a su segmento | lee todo (firmar no cifra) | no lee (canal cifrado) |
| Repetición de una petición capturada | posible | posible | posible dentro de la vigencia del token (se mitiga atando firma a método, ruta, fecha) | no aplica a otra conexión; sí dentro de una sesión robada |

## 3 · Opciones

### A · Segmentación de red + identidad de servicio FIRMADA (sin TLS entre servicios)

- **Qué es:** (1) redes separadas en Coolify (P1.H4.M3: `pay-vault` solo alcanzable por `pay-payments`, más lo que se decida para `pay-ledger`) y (2) reemplazar la cadena `x-service-id` por
  un token corto y firmado (clave por servicio o por par, con vigencia de segundos) que `serviceHeaders` agregue y `ServiceIdentityGuard` verifique. La clave vendría de OpenBao
  (hoy en el perfil `full`, que no se pudo levantar en el entorno de trabajo: `ola-1/P1/REPORTE.md`).
- **Qué agrega:** cierra la suplantación por quien tiene alcance de red sin credenciales; la segmentación reduce el alcance de red y contiene un servicio comprometido.
- **Qué no agrega:** cifrado del canal ni protección ante escucha pasiva; la repetición solo se acota con la vigencia.
- **Costo:** un cambio en `@pay/service-auth` más cablear los mismos 5–6 clientes HTTP internos que hay que tocar de todos modos para la traza (`PROPUESTAS-TRAZA.md` T2); distribución y
  rotación de claves por servicio; reloj sincronizado. Sin cambios de infraestructura de transporte. En el arnés: generar las claves como ya se generan los secretos sintéticos (`generateSecrets`).
- **Riesgo:** es criptografía casera si se inventa el formato (usar un estándar, JWT con EdDSA/HMAC y una biblioteca revisada; yo no verifiqué cuál admite el stack: antes de implementar,
  regla 00 §1.3); la segmentación en Coolify **no la pude comprobar** (no hay acceso acá) y T-01 prevé repartir servicios en varios servidores, donde una red Docker aislada no abarca los
  hosts y hace falta una red superpuesta o una VPN.

### B · mTLS en la aplicación

- **Qué es:** cada servicio tiene un certificado propio (CN/SAN = `pay-<nombre>`) emitido por una CA interna (por ejemplo el PKI de OpenBao o `step-ca`); el servidor exige certificado de cliente,
  el guard obtiene la identidad del certificado del par (no de una cabecera) y los clientes HTTP presentan el suyo y validan el del servidor. La cabecera `x-service-id` pasaría a ser
  informativa o desaparecería.
- **Qué agrega sobre A:** cifrado del canal (escucha pasiva), identidad atada a la conexión (sin repetición entre conexiones), y la identidad la valida la pila TLS antes de que corra código de negocio.
- **Costo:**
  - Código en los 11 servicios y la plantilla (`platform/templates/service`): servidor HTTPS con `requestCert`, un `Agent` con `cert/key/ca` para los clientes (hoy `fetch` global), lectura
    de la identidad del certificado, recarga en caliente al rotar. (API de Node y de undici **no verificadas contra las versiones instaladas**.)
  - Operación: una CA, emisión y renovación automática (certificados de vida corta, p. ej. 24 h), una cadena de confianza con solape para rotar la CA, monitoreo de vencimientos.
  - Salud: los chequeos de Compose/Coolify hacen `GET /health/ready` por HTTP; habría que dejar un puerto/ruta de salud sin mTLS o dar un certificado al chequeador.
  - Arnés e2e: generar certificados por corrida (ya existe `makeReceiverCertificate` en `e2e/lib/infra.ts` para el receptor) y pasar de `http://127.0.0.1` a `https://`; reescribir las
    ayudas `callAs`/`call`. Las pruebas de `x-service-id` de E7 (`asService`) dejan de ser posibles tal cual.
  - Entrada pública: Traefik de Coolify termina TLS hacia afuera; el salto Traefik → `pay-edge` es otro tramo y queda fuera de este análisis.
- **Riesgo:** el modo de falla típico es operativo, no criptográfico: un certificado que vence o una CA mal rotada **tumba el cobro** (los 11 servicios dependen entre sí); depurar
  rechazos de handshake es más lento; añade latencia de handshake (mitigable con conexiones persistentes, que el cliente ya reutiliza si se le da un `Agent`).

### C · Terminar mTLS en un proxy/sidecar y mapear a `X-Service-Id` (lo que presupone el comentario del guard)

- Lo menciono porque es el diseño que el código dice esperar. Exige un proxy por servicio (no hay malla en Coolify), que el puerto del servicio solo acepte conexiones del proxy y que el
  proxy **borre** cualquier `x-service-id` entrante; si no, la suplantación sigue. Es lo más frágil de las tres si algo falla en la configuración, porque el código no puede verificar nada.

## 4 · Comparación resumida

| | Cierra suplantación sin credenciales | Cifra el canal | Costo de código | Costo operativo | Falla típica |
|---|---|---|---|---|---|
| A: segmentación + firma | sí | no | medio (un paquete + clientes) | bajo-medio (claves, reloj) | clave filtrada o red mal segmentada |
| B: mTLS en app | sí | sí | alto (11 servicios + arnés) | alto (CA, rotación, vencimientos) | certificado vencido ⇒ caída |
| C: proxy/sidecar | sí, si la red lo impone | sí (hasta el proxy) | bajo en código | alto (un proxy por servicio) | cabecera sin borrar ⇒ suplantación silenciosa |
| Hoy | no | no | — | — | cualquiera con alcance de red |

## 5 · Lectura (sin decidir)

Si el dueño quiere un orden de menor a mayor costo, esto es lo que yo haría, **con la reserva de que depende de datos que no tengo**:

1. **Primero la segmentación (P1.H4.M3)**: ya está planificada, es barata y es la única medida que hoy reduce el alcance de un atacante de red. Sin ella, A y B protegen menos de lo que parece.
2. **Luego cerrar la suplantación en el perímetro que más pesa, no en todo el grafo a la vez:** los saltos hacia `pay-vault` (donde vive el PAN) y hacia `pay-ledger` (donde se mueve
   el dinero). Ahí A (firma) es el mínimo; B tiene más sentido solo en los saltos que llevan el PAN (`reveal`), porque son los que más justifican cifrar el canal.
3. **mTLS en todo el grafo** (B completa) me parece prematuro mientras no haya quien opere una CA y el perfil `full` (OpenBao) no se haya ejecutado nunca. Pasa a ser razonable si
   T-01 reparte servicios en varios servidores (el tráfico cruza una red real) o si el QSA lo exige.

**Lo que haría cambiar esta lectura (preguntas para el dueño):**
- ¿Qué dice `docs/cumplimiento/pci-alcance.md` (P1.H4.M1, hoy A MEDIAS) sobre cifrar el tráfico interno de los servicios dentro del CDE? Si lo exige, B en los saltos del PAN deja de ser opcional.
- ¿Los servicios irán en un solo host o en varios (T-01, D-09)? ¿Coolify permite la red aislada por servicio y la superpuesta entre hosts?
- ¿Quién emite y rota certificados/claves, y con qué (OpenBao PKI, `step-ca`, otra)? ¿Se tolera que un vencimiento corte los cobros?
- ¿`pay-connectors` va a llamar a `reveal` (hoy no)? Cambia la sensibilidad del salto vault ↔ connectors.

## 6 · Qué no sé / no verifiqué

- No hay mTLS ni proxy en el repo: nada de esto se ejecutó; las afirmaciones del §1 salen del código y de `e2e/flows/e7.e2e.ts`.
- Las capacidades de Coolify/Traefik (redes por servicio, redes entre hosts, TLS interno) no se verificaron.
- Las APIs concretas de TLS de Node/undici y de la biblioteca de firma no se verificaron contra las versiones instaladas; hay que hacerlo antes de escribir una línea (regla 00 §1.3).
- La relación con PCI DSS 4.0.1 (cifrado de PAN en redes internas del CDE) depende del alcance que defina P1.H4.M1 y del QSA; no lo afirmo.
