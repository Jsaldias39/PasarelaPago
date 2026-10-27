# Clasificación: fallos intermitentes de pay-connectors bajo carga (ENVIRONMENT)

- Síntoma: test/callbacks.spec.ts:142 (12 callbacks idénticos simultáneos) y 'POST /transfers › 10 pedidos simultáneos' fallan solo cuando varias suites corren a la vez (3 copias + agentes).
- Reproducción negativa: con CPU saturada (4 quemadores) la prueba pasa 5/5; 3 copias concurrentes de las pruebas de carrera pasan 10/10 cada una.
- Evidencia de causa: Postgres con max_connections=100 y pools de prueba de hasta 60 conexiones por suite.
- `docker logs pay-postgres-1 | grep -ci 'too many clients'` = 860; ejemplo: FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute.
- Aislamiento de datos: createIsolatedDatabase usa un esquema aleatorio por suite, así que no hay estado de tablas compartido.
- Clase: ENVIRONMENT. Acción: platform/compose.yml sube max_connections a 400 (se aplica al reiniciar Postgres); pools de test de 60 se mantienen.
- No cubierto: no se vio el cuerpo exacto de la respuesta fallida (la reproducción con diagnóstico no falló); falta confirmarlo tras reiniciar Postgres con 400 repitiendo 3 suites completas concurrentes.
