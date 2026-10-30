> **AVANCE: 15 / 27 — 55,6 %.** (`HECHO` 15 · `A MEDIAS` 5 · `TODO` 7 · `BLOQUEADO` 0)

# Reporte P1 — ola 1: plataforma, contratos, borde y webhooks

- Fecha: 2026-10-27 · Carril: [`P1-plataforma-contratos-y-borde.md`](../../../plan/carriles/P1-plataforma-contratos-y-borde.md) · Rama: `claude/adoring-allen-ly7r6f`
- **Peldaño de evidencia: `TESTED`** en las 15 `HECHO` (Postgres, Redis y NATS reales). No hay `VERIFIED` ni `REGRESSION_VERIFIED`: faltan el stack E1–E8 (ola 3), Svix real, mTLS y Jaeger.
- Verificación del integrador (otra persona distinta de quien implementó): salidas en `docs/trabajo/ola-1/integracion/evidencia/` y `evidencia/` de este carril.
- Commits: `42efc32`, `950e35a`, `3f68f1a`.

## Completado (CA cumplido y DoD ejecutado; salida en `evidencia/<ID>.txt`)

| ID | Qué se logró | Prueba principal |
|---|---|---|
| P1.H1.M2–M6 | Plantilla de servicio NestJS 11 + MikroORM 7, `@pay/money`, `@pay/problem`, `@pay/idempotency` y `@pay/webhook-signature` (ola 0) | `docs/trabajo/ola-0/evidencia/` y `evidencia/gates.txt` |
| P1.H1.M9 | Adaptador transaccional de `orm-queryable` | 7 pruebas, 5 corridas; integrador: 7/7 |
| P1.H2.M1 | Réplica de claves por NATS real; la revocación sirve en menos de 5 s | 28 pruebas × 5 |
| P1.H2.M2 | Límites por IP, por clave y freno a fallos de autenticación | 7 pruebas × 5 |
| P1.H2.M4 | Matriz de autorización negativa; `X-Pay-Mode` reenviado sale del registro de la clave (D-28) y se descarta el del cliente | 25 pruebas × 5 |
| P1.H3.M2 | API `webhook_endpoints`, rotación con dos firmas, secretos sellados | 72 pruebas × 5 |
| P1.H3.M3 | Receptor que verifica la firma | 18 pruebas |
| P1.H3.M4 | E6 con NATS real: 12 eventos llegan una vez cada uno tras 3×500 y luego 200; el 410 deshabilita el endpoint | `P1.H3.M4-E6.txt` |
| P1.H3.M5 | Política de payload: 0 coincidencias del grep sobre los 21 eventos públicos | `P1.H3.M5.txt` |
| P1.H3.M6 | SSRF: el DNS se revalida en cada entrega y hay plazo duro de pared | `P1.H3.M6.txt` |
| P1.H4.M2 | `docs/cumplimiento/preguntas-legales.md`: 30 preguntas con fuente y supuesto | `P1.H4.M1-M2.txt` |

Verificación del integrador con el código final:

```text
contracts:lint   11 contrato(s) válido(s)                       exit 0
contracts:events 38 mensajes, 38 válidos, 333/333 mutantes rechazados
pay-edge         Tests: 324 passed, 324 total (9 suites)
pay-webhooks     Tests: 344 passed, 344 total (9 suites)
orm-queryable    Tests: 7 passed, 7 total
typecheck/build  pay-edge, pay-webhooks: exit 0
yarn eslint services/pay-edge services/pay-webhooks contracts/packages/orm-queryable: exit 0
```

Lo ocurrido con el eslint: en el ciclo del agente el `eslint` de `pay-edge` no terminó en 200 s porque la máquina estaba cargada y su salida no llegó a pegarse. El integrador lo corrió después: `yarn eslint services/pay-edge` → exit 0. El archivo de tarea `bdpba0tq0.output` que se citó como resultado de eslint no contiene ninguno: solo tiene dos líneas `ruta:conteo` (`docs/cumplimiento/pci-alcance.md:2`, `docs/trabajo/ola-1/P1/DECISIONES-TOMADAS.md:2`), propias de un `grep -c`, y no se usa como evidencia.

## A medias

### P1.H1.M1 — Compose local con las 8 dependencias
- Qué anda: Postgres (un rol y una base por servicio), NATS JetStream, Redis, Temporal (con su base), Jaeger y Watchman (sandbox) llegan a `healthy` con `docker compose up -d` (`docs/trabajo/ola-0/evidencia/P1.H1.M1-compose.txt`).
- Qué no se verificó: TigerBeetle, Svix y OpenBao están en el perfil `full` y no se ejecutaron: sus imágenes no se pudieron bajar en el entorno de trabajo. TigerBeetle se probó aparte por binario con `platform/scripts/tigerbeetle-dev.sh`.
- Qué falta exactamente: correr `--profile full` con acceso al registro y pegar `docker compose ps --format json | jq '.[].Health'` con las 8 en `healthy`.
- Dónde quedó: `platform/compose.yml` (con `max_connections=400`, aplicado solo al reiniciar Postgres), compila y arranca.

### P1.H1.M7 — Detector de cambios incompatibles (`oasdiff`)
- Qué anda: `contracts/scripts/check-breaking.mjs` con 11 pruebas (11/11 con `oasdiff` en el `PATH`; 2/11 sin él) y falla sobre una copia de `public-v1` marcada congelada.
- Qué no anda: no está cableado al `package.json` raíz ni al CI; ningún contrato está `v1-frozen` salvo `common.yaml`.
- Qué falta exactamente: script `contracts:breaking` en la raíz, instalar `oasdiff` en el CI y congelar los contratos cuando sus dueños los revisen.
- Dónde quedó: `contracts/scripts/`, compila.

### P1.H1.M8 — CI reutilizable
- Qué anda: `.github/workflows/ci.yml` existe y los pasos se corren a mano con los mismos comandos.
- Qué no anda: el flujo nunca se ejecutó en GitHub y no hay log del job de separación de bases.
- Qué falta exactamente: una corrida real del CI en un PR de `dev` y pegar el log donde el servicio *hello* falla al leer `pay_ledger`.
- Dónde quedó: `.github/workflows/ci.yml`; `platform/scripts/check-db-separation.sh` pasa 168/168 a mano.

### P1.H2.M3 — Reenvío y resiliencia del borde
- Qué anda: reenvío, `traceparent`, cortacircuitos y respuestas 502/503/504 contra dobles.
- Qué no anda: mTLS entre servicios y la captura de la traza en Jaeger.
- Qué falta exactamente: certificados por servicio y una prueba que muestre la traza completa en Jaeger.
- Dónde quedó: `services/pay-edge/src/proxy/`, compila.

### P1.H3.M1 — Motor de entrega con Svix
- Qué anda: el consumidor y el motor en proceso (doble de Svix).
- Qué no anda: no existe `SvixEngine`.
- Qué falta exactamente: acceso a la documentación de Svix de la versión instalada y el adaptador real; no se inventó su API (regla de anti-invención).
- Dónde quedó: `services/pay-webhooks/src/engine/`, compila.

### P1.H4.M1 — Mapa de alcance PCI DSS v4.0.1
- Qué anda: `docs/cumplimiento/pci-alcance.md` clasifica 12 servicios y cruza los 12 requisitos.
- Qué no anda: sin revisión de P3 ni de un QSA.
- Qué falta exactamente: revisión de P3 y del QSA; resolver A-1 y A-2 (abajo).
- Dónde quedó: `docs/cumplimiento/`.

## Pendiente

| ID | Estado | Qué lo destraba |
|---|---|---|
| P1.H4.M3 | TODO | Coolify con acceso al proyecto de pagos |
| P1.H5.M1–M5 | TODO | Ola 4 (sandbox mock): requiere `pay-mockbank` y los servicios de la ola 2 |

## Evidencia

Índice en `docs/trabajo/ola-1/P1/evidencia/` (14 archivos por microtarea más `contracts-lint.txt` y `gates.txt`) y en `docs/trabajo/ola-1/integracion/evidencia/`.

## No cubierto

- Svix real, mTLS y Jaeger.
- El proxy de salida sin ruta a la red interna (control de despliegue, no de código).
- Carga a la escala de T-01.
- Un PAN partido en varios campos o codificado en base64/hex.
- Modo `live`.

## Desvíos del plan

- Correcciones por revisiones de seguridad automáticas, aplicadas en el mismo carril: `pan-guard` ahora parsea el JSON, rechaza claves duplicadas, colapsa corridas de separadores y prueba Luhn en toda ventana de 13 a 19 dígitos. Se corrigió además el schema `Mandate` y los escapes literales invisibles de `INVISIBLE` y `SEPARATORS` (hallados por el lint).

## Riesgos residuales

- **Falsos positivos del guardia de PAN (DT-19):** un número o cadena de 13 o más dígitos seguidos que no es tarjeta se rechaza con 422. Tasas medidas: ≈10 % con 13 dígitos, ≈65 % con 16, ≈97 % con 20, ≈100 % con 30 o más.
- Redis fail-open (DT-1).
- Quien publica en NATS puede crear claves o disparar webhooks mientras no haya credenciales por servicio (PROPUESTAS #7).

## Decisiones y ambigüedades

`DECISIONES-TOMADAS.md` (DT-1 a DT-24, A-1 a A-5) y `PROPUESTAS.md` (10 propuestas de contrato; solo se aplicó la 3). A confirmar con otra persona:

- **A-1:** si `pay-connectors` es CDE depende de si la bóveda reenvía la tarjeta o la devuelve (P3, P4 y QSA).
- **A-2:** quién aloja el formulario de captura, el banco o la bóveda, define SAQ A o SAQ D (dueño y QSA).
- **DT-19:** exigir además el prefijo de marca (IIN) al guardia de PAN (P3 y QSA).
