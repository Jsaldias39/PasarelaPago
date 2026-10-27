# e2e — arnés de integración real

Levanta los 11 servicios reales (`node dist/main.js`) contra la infraestructura de `platform/compose.yml` y un
TigerBeetle privado, en `PAY_MODE=sandbox` con el conector `mock`. Matriz, hallazgos y límites:
[`docs/trabajo/ola-2/P1/ARNES.md`](../docs/trabajo/ola-2/P1/ARNES.md).

```bash
yarn e2e:up | e2e:down | e2e:boot | e2e:smoke
yarn e2e            # jest (humo, degradado, E6, D-32, ledger, callbacks, guardia de modo, unitarias del arnés), 1 worker
yarn e2e:pending    # E1/E2 de punta a punta: escritos, fuera de la suite por defecto hasta que P3/P5 cierren D-29/D-30
yarn e2e:typecheck
```

- Requiere la infra de Compose arriba y los `dist/` construidos.
- Un solo stack a la vez (`e2e/.run/state.json`). `e2e:down` limpia uno huérfano (por PID verificado).
- Sin datos reales: los secretos se generan sintéticos en cada corrida; nada se commitea (`e2e/.run/` ignorado).
- Se espera siempre por condición (`/health/ready`, sondeos), nunca por tiempo fijo.
- API: `startStack(opts)` / `stopStack(stack)` en `stack.ts`; `stack.call(name, method, path)` y
  `stack.callAs(from, name, …)` (añade `x-service-id`, `x-pay-mode`, `x-merchant-id`).
- `lib/seed.ts` siembra un comercio sandbox (DOBLE declarado del onboarding) con llave `sk_test_`.
- `lib/receiver.ts` es el comercio de prueba: HTTPS con certificado autofirmado, con rutas `up`/`down`/`gone`.
- Las dependencias `pg`, `nats` y `yaml` se importan desde el `node_modules` raíz (no están declaradas).
- `flows/` es la suite por defecto (todo debe pasar). `pending/` son pruebas escritas contra el contrato que hoy no pueden pasar por una
  causa ajena documentada en ARNES.md § Pendientes; cuando la causa se resuelve se mueven a `flows/`.
