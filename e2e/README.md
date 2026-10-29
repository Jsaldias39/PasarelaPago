# e2e — arnés de integración real

Levanta los 11 servicios reales (`node dist/main.js`) contra la infraestructura de `platform/compose.yml` y un
TigerBeetle privado, en `PAY_MODE=sandbox` con el conector `mock`. Matriz, hallazgos y límites:
[`docs/trabajo/ola-2/P1/ARNES.md`](../docs/trabajo/ola-2/P1/ARNES.md).

```bash
yarn e2e:up | e2e:down | e2e:boot | e2e:smoke
yarn e2e            # jest, 1 worker: humo, degradado, E1, E1 con pagador simulado, E2, E3, E4, E5, E6, E7, E8, seed:sandbox, D-32, ledger, callbacks, guardia de modo, capa sandbox (pay-mockbank), candado y unitarias del arnés
yarn e2e:pending    # solo lo que hoy no puede pasar (falla a propósito); hoy `pending/` está vacío: los hallazgos 13 y 14 se corrigieron y sus reproductores pasaron a flows/
yarn e2e:typecheck
yarn load:harness   # prueba de carga de T-01 con el stack del arnés en un solo proceso (docs/trabajo/ola-3/P1/CARGA.md)
```

- Requiere la infra de Compose arriba y los `dist/` construidos.
- Un solo stack a la vez: candado atómico `e2e/.run/stack.lock` (lib/lock.ts; con un stack vivo el segundo falla con «stack en uso por runId X pid Y»). `e2e:down` limpia uno huérfano (por PID verificado) y tampoco toca un stack vivo.
- `startStack({ mockbank: true })` suma `pay-mockbank` (capa sandbox); `RECONCILE_INTERVAL_MS` del conector NO se acelera por defecto: el flujo que lo necesita (E8) lo fija con `envOverrides` (ARNES.md § Tanda 4a).
- Sin datos reales: los secretos se generan sintéticos en cada corrida; nada se commitea (`e2e/.run/` ignorado).
- Se espera siempre por condición (`/health/ready`, sondeos), nunca por tiempo fijo.
- API: `startStack(opts)` / `stopStack(stack)` en `stack.ts`; `stack.call(name, method, path)` y
  `stack.callAs(from, name, …)` (añade `x-service-id`, `x-pay-mode`, `x-merchant-id`).
- `lib/seed.ts` siembra un comercio sandbox (DOBLE declarado del onboarding) con llave `sk_test_`.
- `lib/receiver.ts` es el comercio de prueba: HTTPS con certificado autofirmado, con rutas `up`/`down`/`gone`.
- Las dependencias `pg`, `nats`, `yaml` y `@temporalio/client` se importan desde el `node_modules` raíz (no están declaradas).
- `flows/` es la suite por defecto (todo debe pasar). `pending/` son pruebas escritas contra el contrato que hoy no pueden pasar por una
  causa ajena documentada en ARNES.md § Pendientes; cuando la causa se resuelve se mueven a `flows/`.

## E3 y E7 (tanda P1.H5.M3) — dobles que usan

- `flows/e3.e2e.ts` — reembolso parcial con retención y fallo del conector (12 servicios). Dobles declarados: `pay-mockbank` (banco simulado); `lib/fault-proxy.ts` (`BankFaultProxy`, entre `pay-connectors` y el banco: reenvía la orden, el banco la EJECUTA y corta la conexión, para el fallo AMBIGUO que el banco no sabe producir con reembolsos); saldo disponible por asiento de apertura sintético (`fundWallet`); tiempos del arnés de `pay-payments` (espera 3 s, consulta 1 s, 2 intentos, reintento lento 1 s). El fallo definitivo de punta a punta está en `flows/e3-fallo-definitivo.e2e.ts` (hallazgo 13, corregido en `pay-connectors`).
- `flows/e7.e2e.ts` — tarjeta por campos alojados sin un PAN fuera de pay-vault. PAN SINTÉTICOS (números de prueba públicos; `lib/pan-scan.ts`). Dobles: `lib/hosted-fields-preload.cjs` (campos alojados del PSP, `NODE_OPTIONS=--require` solo en el proceso de pay-vault), la prueba hace de `pay-connectors` para `reveal` y la autorización en el banco simulado (el conector no llama a la bóveda, hallazgo 15) y `lib/otlp-sink.ts` (colector de trazas). Escanea (`lib/sensitive-sources.ts`): logs, bus, todas las filas de las 12 bases, historial de Temporal y trazas.
- Piezas con prueba propia (sin stack): `lib/fault-proxy.spec.ts`, `lib/pan-scan.spec.ts`, `lib/otlp-sink.spec.ts`.

## Ola 4 (P1.H5.M1/M2/M4)

- `yarn test:parity` (`e2e/parity.ts`, `lib/parity.ts`): PARIDAD = mismo conjunto de pruebas y MISMO estado en el enlace en proceso y en el de `pay-mockbank`. El sufijo « — NO APLICA: …» de la suite se ignora al emparejar títulos, pero la inaplicabilidad tiene que estar DECLARADA en `DECLARED_NOT_APPLICABLE` (par, lado, prueba, motivo y referencia); un NO APLICA no declarado, un `failed` en cualquier lado o un estado distinto es DIFERENCIA (exit 1). `todo`/`skipped` sin sufijo solo valen si son idénticos en ambos lados y se imprimen con su cuenta. Los conectores del Mercantil se informan BLOQUEADOS (Q-01, Q-11).
- `flows/seed-sandbox.e2e.ts`: corre `e2e/seed-sandbox.ts` (la entrada real de `yarn seed:sandbox`) DOS veces contra el stack de 12 servicios del arnés, con `SANDBOX_*_URL` y un `SANDBOX_DIR` temporal.
- Lo que no se puede probar aquí (Compose de la capa sandbox: ghcr 403, Docker Hub 429, TLS interceptado): `docs/trabajo/ola-4/P1/BLOQUEOS.md`.
- `flows/e1-payer.e2e.ts` (P4.H4.M4, E1 sin intervención manual): `pay-mockbank` en `MOCKBANK_PAYER_MODE=manual` (único ajuste del arnés; en `auto` el banco paga solo); el QR de la API pública lo paga `POST /sandbox/payer/pay` y el cobro termina `succeeded` por el callback firmado banco→pay-connectors. Límites: pago repetido, QR con otro importe (404/422), QR vencido (409). Inválidos: QR desconocido o no EMV, identidad ajena (403). El importe del QR no se puede forzar distinto del cobro por el pagador (el banco busca el QR por texto exacto): la rama `amount_mismatch` de `payByQr` es inalcanzable por esta vía.
