> **AVANCE (tanda 3d P2): reconciliador implementado y probado (13/13 con TigerBeetle y Postgres reales) · cortes de conexión de Postgres: 10/10 por servicio EN AISLADO, corrida completa ×2 PENDIENTE.** Carril P2 sin cambio de microtareas (17 / 19).

# Reporte corto — P2 tanda 3d

Sin commit. Detalle y evidencia: [`GATES.md`](./GATES.md) (gate 11 y fila «Cortes de conexión»), [`PROPUESTAS.md`](./PROPUESTAS.md) #25 y #27–#31, `evidencia/3d-*`.

## Completado (peldaño `TESTED`)
| Qué | Prueba | Resultado |
|---|---|---|
| **Reconciliador TigerBeetle → Postgres** (`reconciler.service.ts`, marca `user_data` en toda transferencia, candado de una réplica, intervalo configurable, falla cerrado, solo lee) | `reconciler.spec.ts` | 13/13 ×2: correcto, límite (1 pata, varias patas enlazadas, contracargo partido, retención pendiente, segunda fase adelantada, lo reciente, retención vencida), inválido (otro despliegue / otro ledger / sin marca / otro modo, idempotente ×3, `failed` ante error de lectura, `skipped` con candado ajeno). Caída real inyectada con un trigger de prueba; el reintento con la misma clave **adopta sin duplicar** |
| `guardPool` (copia idéntica a la de pay-connectors) en el pool de ledger y settlement | `pool-resilience.spec.ts` | 10/10 por servicio, 3 corridas: ocioso, todas a la vez + ORM, corte a mitad de consulta (500 problem+json sin SQL), conexión prestada, log solo con el nombre del error, `@pay/idempotency.atomic`, `processOnce`, relé del outbox (publicado-sin-marcar ⇒ se reentrega) |
| Controles negativos | `3d-control-negativo-pool-*.txt` | sin manejador del pool: 6 caen; sin el del cliente prestado: 3 caen |
| `inTransaction`: el `ROLLBACK` de una conexión muerta ya no tapa el error; `pg_advisory_unlock` de settlement idem | cubierto por la prueba de conexión prestada | PASS |
| `@pay/idempotency` ahora enmascara la clave con forma de PAN (P1): mis dos `it.failing` pasaron a pruebas normales | `sensitive-data.spec` ×2 | 5/5 y 3/3 |

## A medias
### Corrida completa ×2 de ledger y settlement (serie 3d)
- Qué anda: todas las pruebas que corrieron pasaron (299 + 299 + 570); el reconciliador y `pool-resilience` pasan por separado.
- Qué no anda: en las corridas completas la suite `pool-resilience` **no se ejecutó** (`failed to run: Unhandled error`): otros carriles cortaron conexiones del mismo Postgres y el pool auxiliar de `createIsolatedDatabase` (`@pay/testing`, sin `guardPool`) lo propagó. Settlement tiene 1 sola corrida completa 3d (la 2 no se hizo: pedido de dejar la máquina quieta).
- Qué falta exactamente: re-correr `yarn test --maxWorkers=2` ×2 por servicio con TigerBeetle/NATS propios cuando el coordinador libere la máquina; correr antes `yarn typecheck` (el cambio de `pool-resilience.spec.ts` —`guardedIsolatedDatabase`— está **escrito, sin typecheck ni corrida**).
- Dónde quedó: `services/pay-{ledger,settlement}/test/pool-resilience.spec.ts`; el resto compila (typecheck 0 antes de ese último cambio) y `yarn lint` de la raíz da exit 0.

## Pendiente (dueño)
| Qué | Dueño |
|---|---|
| Tablas del modelo para visibilidad persistente y reconstrucción de huérfanos (#27) | Modelo |
| Tolerancia a transferencias anteriores a la marca antes de un ledger con datos (#28) | Coordinador |
| `guardPool` en los otros servicios / reemplazar copias por el de `@pay/idempotency`; guardar los pools de `@pay/testing` (#29) | P1 |
| Métricas fuera del proceso (#30) | P1 |

## No cubierto
Corte justo entre `COMMIT` y su respuesta; reconstrucción automática de la fila; la etapa 2 del reconciliador (fila fuera de la ventana de `LOOKBACK`, que se busca en toda la historia) solo se razonó, no tiene prueba; ledger con datos previos a la marca.

## Desvíos
Cambié 14 llamadas de simulación de caída en `transactions.spec`/`holds.spec` para que la transferencia armada a mano lleve la misma marca que la del servicio (mismas aserciones). `docker`: NATS y TigerBeetle propios detenidos; nada queda corriendo.
