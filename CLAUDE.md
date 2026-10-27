# PasarelaPago — pasarela de pagos ALOVIDA

Monorepo de 11 microservicios backend (NestJS 11, MikroORM 7, PostgreSQL, Yarn 4). Panorama:
`docs/plan/PLAN-MAESTRO.md`. Decisiones con ID estable: `docs/plan/DECISIONES.md`.

## Antes de tocar nada

1. **Leé tu carril** en `docs/plan/carriles/` y escribí solo en tus carpetas. Tocar el servicio de otro carril es un defecto, no una ayuda.
2. **Separación:** un servicio no lee la base de otro y no importa código de otro servicio. Solo `contracts/` y las librerías técnicas `@pay/*`.
3. **Contratos primero:** la API y los eventos se cambian en `contracts/`. Un contrato `v1-frozen` no se rompe sin la aprobación de su dueño y de sus consumidores.
4. **Dinero:** montos en unidades menores enteras (`amount_minor`, BOB). Nunca `float`. El cálculo de comisiones vive solo en `@pay/money`.
5. **El dinero se mueve solo en `pay-ledger`.** Los errores se corrigen con asientos inversos, nunca con `UPDATE` ni `DELETE`.
6. **El PAN solo existe en `pay-vault`.** Nunca en logs, trazas, eventos, errores ni otra base.
7. **Idempotencia:** toda mutación pública exige `Idempotency-Key`; todo productor usa outbox; todo consumidor, inbox.
8. **Modo A** (D-02). El rail del modo B es un doble declarado: no se presenta como real.
9. **No se mueve dinero real** sin cuenta recaudadora ni visto bueno legal (T-03).
10. Un doble de otro servicio se declara como doble, en los tres niveles: correcto, límite e inválido.
11. **Un resultado ambiguo no es un fallo.** Después de enviar una orden que mueve dinero (transferencia, cobro, reembolso, post/void de un hold), un timeout, un corte, un 5xx o un 404/502 sin el cuerpo de error exacto del contrato **no prueban que no se ejecutó**. Nunca se anula un hold, se borra una fila ni se responde «no existe» o «no disponible» por ambigüedad: se conserva el estado, se reintenta con la MISMA clave de idempotencia, se consulta de forma autoritativa y, si sigue sin resolverse, se escala a una persona. Solo es definitivo lo que el contrato declara definitivo (por ejemplo `404 transfer_not_found`, `502 connector_unavailable`). Los registros de dinero son de solo-agregar: se cambia de estado, no se borra.
12. **El modo `test`/`live` lo fija `pay-edge` desde el registro de la clave (D-28)**: nunca se toma del token ni del cliente.
13. Sin `console.*` en el código desplegado (lo hace cumplir el lint).

## Comandos (por servicio, desde `services/<servicio>`)

```bash
yarn typecheck
yarn lint
yarn test
```

Stack local: `docker compose -f platform/compose.yml up -d` (lo crea P1.H1.M1).

## Git

`main` + `dev`. Los PRs van a `dev` y el merge exige revisión humana. Los commits citan el ID de
microtarea (`P3.H2.M4`) y, si aplica, la decisión (`D-07`).
