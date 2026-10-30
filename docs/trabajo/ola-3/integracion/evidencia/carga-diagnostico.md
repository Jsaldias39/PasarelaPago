# Diagnóstico de la prueba de carga en esta máquina (4 vCPU compartidas)

Resultados medidos con `yarn load:harness` (criterio escrito antes en `docs/trabajo/ola-3/P1/CARGA.md`):

| Tasa | Veredicto | p99 creación | 5xx | Doble asiento | Colgados |
|---|---|---|---|---|---|
| 5 rps | APRUEBA | < 2 s | 0 | 0 | 0 |
| 10 rps | NO APRUEBA | ≈ 9,2–9,7 s | 0 | 0 | 0 |
| 25 rps | NO APRUEBA | ≈ 10 s | 0 | 0 | 5284/6750 sin llegar a terminal a tiempo |

Muestreo cada 10 s durante la corrida de 10 rps (`top` + `docker stats`):

- Los servicios Node suman ≈ 1 núcleo en total.
- `temporal-server` 50–130 %, `pay-temporal` 58–96 %, `temporal-db` 46–77 %, `pay-postgres` 28–56 %, `watchman` 0–35 %, `docker-proxy` ≈ 25 %.
- Conclusión (clase `ENVIRONMENT`): el cuello de botella es la infraestructura co-alojada (Temporal + su base + Postgres) en 4 vCPU, no los servicios de la pasarela. Esta máquina mide sus propios límites, **no** la capacidad de producción (T-01).

Invariantes de dinero bajo saturación (lo que sí se puede afirmar): 0 respuestas 5xx, 0 doble asiento en el libro, 0 inconsistencias de idempotencia.

Hallazgo de producto abierto: ≈ 4 % de los intentos limpios terminan `failed/risk_denied` cuando Watchman agota el tiempo (la decisión `review` con `screened:false`). El cliente de `pay-payments` aún no reintenta ese caso; lo corrige P3 (tanda 2g) y se re-mide.

No cubierto: capacidad en el despliegue real (Coolify multiservidor); el muestreador del harness solo atribuye procesos Node (conviene que incluya `docker stats`).
