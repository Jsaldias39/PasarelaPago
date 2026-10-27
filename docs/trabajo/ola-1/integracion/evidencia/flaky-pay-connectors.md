# Clasificación: fallos intermitentes de pay-connectors bajo carga (ENVIRONMENT)

- Síntoma: test/callbacks.spec.ts:142 (12 callbacks idénticos simultáneos) y 'POST /transfers › 10 pedidos simultáneos' fallan solo cuando varias suites corren a la vez (3 copias + agentes).
- Reproducción negativa: con CPU saturada (4 quemadores) la prueba pasa 5/5; 3 copias concurrentes de las pruebas de carrera pasan 10/10 cada una.
- Evidencia de causa: Postgres con max_connections=100 y pools de prueba de hasta 60 conexiones por suite.
- `docker logs pay-postgres-1 | grep -ci 'too many clients'` = 860; ejemplo: FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute.
- Aislamiento de datos: createIsolatedDatabase usa un esquema aleatorio por suite, así que no hay estado de tablas compartido.
- Clase: ENVIRONMENT. Acción: platform/compose.yml sube max_connections a 400 (se aplica al reiniciar Postgres); pools de test de 60 se mantienen.
- No cubierto: no se vio el cuerpo exacto de la respuesta fallida (la reproducción con diagnóstico no falló); falta confirmarlo tras reiniciar Postgres con 400 repitiendo 3 suites completas concurrentes.

## Confirmación tras reiniciar Postgres con max_connections=400

- `docker exec pay-postgres-1 psql -U postgres -tAc "show max_connections"` → 400.
- Ronda 1 (3 suites completas de pay-connectors a la vez): 518/519, 519/519, 519/519. El fallo: `transfers.spec › corrida 5: banco caído y dos envíos simultáneos` esperaba `[200, 502]` y recibió `[201, 502]`.
- Clasificación: TEST_BUG (no ENVIRONMENT). Quien inserta la fila (201) no siempre gana el candado de envío; el otro pedido la encuentra creada (200), envía y recibe el 502, y el creador ve el estado resuelto y responde 201. `calls` = 1 y el estado final `failed/connector_unavailable` se siguen exigiendo. La aserción pasó a aceptar `[200, 502]` o `[201, 502]` y exige exactamente un 502.
- Rondas 2 y 3 (3 suites completas a la vez cada una, 6 corridas): 519/519 en las seis.
- No cubierto: las fallas anteriores de callbacks.spec:142 siguen sin reproducirse; se atribuyen a `too many clients` (ENVIRONMENT) por inferencia, no por captura del cuerpo de la respuesta.
