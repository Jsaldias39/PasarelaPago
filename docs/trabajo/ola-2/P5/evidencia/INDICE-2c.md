# Evidencia P5 — ola 2, tanda 2c

| Punto | Prueba | Resultado |
|---|---|---|
| a) alta del primer comercio con credencial de operador real | `pay-merchants/test/operator-credential.spec.ts` (41), `scripts/sandbox-operator-token.mjs` | JWT RS256 atado al modo; camino completo alta→KYC→contrato→activación→tarifa→clave con credenciales por rol; negativas: sin credencial 401, rol insuficiente 403, credencial de otro modo 401 (en ambos sentidos), otro emisor/vencida/otra clave; el script se niega con live o sin PAY_MODE |
| b) D-32 | `pay-merchants/test/merchant-close-keys.spec.ts` (7) | cerrar revoca todas las claves vivas (`merchant_closed`, un `api_key.revoked` por clave antes de `merchant.closed`); suspender no revoca y reactivar restaura (mismo hash); las ya revocadas no resucitan; sin carreras. Motivo nuevo pendiente en el AsyncAPI: PR-16 |
| c) D-29 | `pay-risk/test/screening-parties.spec.ts`, `contract-conformance.spec.ts`, `assessments.spec.ts` | comercio siempre, pagador si dio nombre, gana el más grave; `screening_not_provided` solo por falta del nombre del comercio; extensión del contrato: PR-17 |
| d) pay-schedules ↔ pay-payments | `docs/trabajo/ola-2/P5/PROPUESTAS.md` PR-18 | el contrato SÍ declara a pay-schedules como único llamador de `POST /intents`; no se propone quitar la fila; el desvío (ledger directo) es una decisión del dueño |
| e) PAY_MODE | `startup.spec.ts` en los tres servicios (arranque real de `dist/main.js`), `settings.spec.ts` | explícito, sin valor por defecto; live no arranca con el almacén `fs` / `DISABLE_BACKGROUND_JOBS` (merchants), sin `WATCHMAN_LISTS=current` (risk), con `DISABLE_BACKGROUND_JOBS` (schedules) |
| f) `.env.example` | `env-example.spec.ts` en los tres servicios | cada ejemplo ARRANCA con su configuración; `PORT` único entre los 11; `LEDGER_URL` de schedules → 3105 (era 3102); `WATCHMAN_URL` ↔ Compose; los de P3 desalineados: PR-19 |

Archivos: `2c-gates-typecheck-build.txt`, `2c-gates-eslint-raiz.txt`, `2c-contracts-lint.txt`, `2c-test-2-corridas.txt`.
