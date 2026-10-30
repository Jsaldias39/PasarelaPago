# Pruebas nuevas/relevantes de la ola 3 con su resultado (de jest --json, corrida 1 de la serie 3c con TigerBeetle y NATS propios)

## pay-ledger — 276/276 pasaron en 18 suites

### idempotency-parallel.spec.ts
- passed mutaciones repetidas 10 veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto POST /transactions: una 201 y nueve 200 con el mismo cuerpo; una fila y un solo movimiento
- passed mutaciones repetidas 10 veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto POST /holds: una sola retención; el disponible baja una vez
- passed mutaciones repetidas 10 veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto POST /holds/{id}/post: una sola confirmación; el dinero llega a payout:clearing una vez
- passed mutaciones repetidas 10 veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto POST /holds/{id}/void: una sola anulación; el monto vuelve una vez y no se cobra
- passed mutaciones repetidas 10 veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto contracargo (transferencia con débito a `pending` mayor que lo pendiente): mismo business_ref y clave ⇒ se aplic
- passed mutaciones repetidas 10 veces en paralelo con la MISMA Idempotency-Key ⇒ un solo efecto control: con claves DISTINTAS y la misma operación de negocio, sigue habiendo un solo efecto (idempotencia por b

### faults.spec.ts
- passed TigerBeetle muerto con SIGKILL en medio del servicio (ledger real) mientras está caído: 503 ledger_unavailable en escrituras y lecturas, sin efectos a medias; al volver, el MISMO reintento termina una
- passed TigerBeetle muerto con SIGKILL en medio del servicio (ledger real) la retención vencida durante la caída se resuelve sola al volver: el monto no se pierde ni se duplica

### holds-accounts-fk.spec.ts
- passed ledger_holds → ledger_accounts (FK compuestas por modo) correcto: el servicio registra las dos cuentas ANTES de la retención, aceptada o rechazada
- passed ledger_holds → ledger_accounts (FK compuestas por modo) inválido (por la API): una retención rechazada sobre un comercio que NUNCA operó registra sus cuentas y responde 422 limpio, sin 500 ni fila hué
- passed ledger_holds → ledger_accounts (FK compuestas por modo) inválido (por la API): cuentas con forma inválida o inexistente en el plan se rechazan con 422 de validación ANTES de tocar la base; el constrai
- passed ledger_holds → ledger_accounts (FK compuestas por modo) la reintentada del mismo (business_ref, attempt) tras el rechazo converge: no duplica ni falla por el constraint
- passed ledger_holds → ledger_accounts (FK compuestas por modo) límite: las cuentas existen solo en `test`; una retención en `live` o con una sola de las dos registrada se rechaza
- passed ledger_holds → ledger_accounts (FK compuestas por modo) inválido: una retención con cuentas que no existen en ninguna parte no entra

### sensitive-data.spec.ts
- passed el detector funciona (control negativo) encuentra un canario, un PAN con espacios o guiones, un campo sensible y un nombre; no se queja de un instante en milisegundos ni de un id
- passed pay-ledger: lo que produce con datos sensibles en la entrada logs, respuestas, eventos del outbox y filas de la base quedan sin PAN, CVV, documento ni nombre
- passed GAP conocido (plantilla de servicio, carril P1): la ruta que el cliente escribe se refleja GET /holds/{PAN}: la respuesta no repite el dato de la ruta
- passed GAP conocido (plantilla de servicio, carril P1): la ruta que el cliente escribe se refleja GET /holds/{nombre}: la respuesta no repite el dato de la ruta
- passed GAP conocido (librería compartida @pay/idempotency, carril P1): la clave de idempotencia se guarda tal cual una Idempotency-Key con forma de PAN no llega a la base

### separation.spec.ts
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases el rol del Compose entra a su base y se llama como debe
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases el rol no es superusuario ni puede crear bases, roles, replicar ni saltarse la seguridad por filas; no pertene
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases hay una base por servicio más las de mantenimiento: la lista que se prueba no está vacía por accidente
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases CONNECT está concedido SOLO sobre la base propia: en cada base de servicio, en pay_test y en postgres el privi
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases control: la misma sonda SÍ detecta una conexión permitida (la base propia devuelve null), así que un 42501 de 
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases intentar conectarse con el rol a CADA base de otro servicio, a pay_test y a postgres es 42501 (permission deni
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases template1 también está cerrada al rol de servicio
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases un rol de OTRO servicio tampoco entra a esta base (el espejo de lo anterior)
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases la aplicación completa arranca con ESE rol /health/ready responde 200 con la base propia y el pool de la aplic
- passed separación — pay-ledger arranca con pay_ledger y ese rol no tiene nada en las demás bases la aplicación completa arranca con ESE rol desde el pool de la aplicación, leer o escribir en otra base es imp

### drift.spec.ts
- passed deriva SQL ↔ base ↔ mapa del código (P2.H1.M2, 97.2) sin deriva: el SQL aplicado coincide con lo que el código asume
- passed deriva SQL ↔ base ↔ mapa del código (P2.H1.M2, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) columna obligatoria no mapeada
- passed deriva SQL ↔ base ↔ mapa del código (P2.H1.M2, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) columna opcional que el mapa no conoce
- passed deriva SQL ↔ base ↔ mapa del código (P2.H1.M2, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) tabla ausente, columna ausente, tipo y nulabilidad di
- passed deriva SQL ↔ base ↔ mapa del código (P2.H1.M2, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) tabla sin mapear e índice con nombre generado

## pay-settlement — 560/560 pasaron en 28 suites

### sensitive-data.spec.ts
- passed el detector funciona (control negativo) encuentra el canario en un extracto crudo y no se queja de un identificador normal
- passed pay-settlement: lo que produce con datos sensibles en extractos, peticiones y eventos logs, respuestas, eventos del outbox y filas de la base quedan sin PAN, CVV, documento ni nombre
- passed GAP conocido (librería compartida @pay/idempotency, carril P1): la clave de idempotencia se guarda tal cual una Idempotency-Key con forma de PAN no llega a la base

### drift.spec.ts
- passed deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2) sin deriva: el SQL aplicado coincide con lo que el código asume
- passed deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) columna obligatoria no mapeada
- passed deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) columna opcional que el mapa no conoce
- passed deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) tabla ausente, columna ausente, tipo y nulabilidad di
- passed deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2) el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale) tabla sin mapear e índice con nombre generado
- passed deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2) las restricciones del esquema rechazan lo que el código nunca debe escribir

### separation.spec.ts
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases el rol del Compose entra a su base y se llama como debe
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases el rol no es superusuario ni puede crear bases, roles, replicar ni saltarse la seguridad por filas; no
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases hay una base por servicio más las de mantenimiento: la lista que se prueba no está vacía por accidente
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases CONNECT está concedido SOLO sobre la base propia: en cada base de servicio, en pay_test y en postgres 
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases control: la misma sonda SÍ detecta una conexión permitida (la base propia devuelve null), así que un 4
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases intentar conectarse con el rol a CADA base de otro servicio, a pay_test y a postgres es 42501 (permiss
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases template1 también está cerrada al rol de servicio
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases un rol de OTRO servicio tampoco entra a esta base (el espejo de lo anterior)
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases la aplicación completa arranca con ESE rol /health/ready responde 200 con la base propia y el pool de 
- passed separación — pay-settlement arranca con pay_settlement y ese rol no tiene nada en las demás bases la aplicación completa arranca con ESE rol desde el pool de la aplicación, leer o escribir en otra bas
