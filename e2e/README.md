# e2e — arnés de integración real

Levanta los 11 servicios reales (`node dist/main.js`) contra la infraestructura de `platform/compose.yml` y un
TigerBeetle privado, en `PAY_MODE=sandbox` con el conector `mock`. Matriz, hallazgos y límites:
[`docs/trabajo/ola-2/P1/ARNES.md`](../docs/trabajo/ola-2/P1/ARNES.md).

```bash
yarn e2e:up | e2e:down | e2e:boot | e2e:smoke
yarn e2e            # jest, 1 worker: humo, degradado, E1, E2, E4, E5, E6, E8, D-32, ledger, callbacks, guardia de modo, capa sandbox (pay-mockbank), candado y unitarias del arnés
yarn e2e:pending    # solo lo que hoy no puede pasar: e2e/pending/risk-timeout.e2e.ts, el reproductor del hallazgo 9 de ARNES.md (falla a propósito)
yarn e2e:typecheck
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
- Las dependencias `pg`, `nats` y `yaml` se importan desde el `node_modules` raíz (no están declaradas).
- `flows/` es la suite por defecto (todo debe pasar). `pending/` son pruebas escritas contra el contrato que hoy no pueden pasar por una
  causa ajena documentada en ARNES.md § Pendientes; cuando la causa se resuelve se mueven a `flows/`.
