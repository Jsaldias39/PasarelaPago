# Evidencia del carril P5, ola 1

Salidas literales. Peldaño por área: **TESTED** (pruebas dirigidas contra Postgres real). Nada llegó a `VERIFIED`/`REGRESSION_VERIFIED`: el libro mayor, el almacén de objetos de KYC y el verificador de operadores son **dobles declarados**, y Watchman es `v2-static` (2019, solo sandbox).

| ID | Estado | Evidencia |
|---|---|---|
| P5.H1.M1 | A MEDIAS | `DECISIONES-TOMADAS.md` D5-01; sin verificador de deriva (no hay modelo) |
| P5.H1.M2 | HECHO | `services/pay-merchants/test/merchants-state.spec.ts` (kill-test: activar sin KYC o sin contrato ⇒ 409; 10 activaciones simultáneas ⇒ 1 efecto) |
| P5.H1.M3 | HECHO | `kyc.spec.ts` (tipo real por magic bytes, tamaño, fuera de la base, sin PII) y `authz.spec.ts` (FsObjectStore, privacidad) |
| P5.H1.M4 | HECHO | `legal-contract.spec.ts` (aceptación inmutable por trigger) |
| P5.H1.M5 | HECHO | `fees.spec.ts` (versiones inmutables, evento validado contra AsyncAPI) |
| P5.H1.M6 | HECHO | `api-keys.spec.ts` (D-27 y D-28; secreto en ninguna tabla; rotación; barrido ×5) y `authz.spec.ts` |
| P5.H1.M7 | HECHO | `fees.spec.ts` (Bs 100,00 al 3 % ⇒ 300/9700; propiedad de 5.000 casos con semilla fija) |
| P5.H2.M1 | A MEDIAS | ola 0 (no tocado) |
| P5.H2.M2 | HECHO | `pay-risk/test/engine.spec.ts` (todas las combinaciones), `assessments.spec.ts`, `rule-sets.spec.ts` |
| P5.H2.M3 | HECHO | `watchman.spec.ts` (Watchman real + [DOBLE] para fallos) y `assessments.spec.ts` |
| P5.H2.M4 | A MEDIAS | [`P5.H2.M4.txt`](./P5.H2.M4.txt) (ENVIRONMENT) |
| P5.H2.M5 | HECHO | `assessments.spec.ts` («rastro auditable y privacidad») |
| P5.H3.M1 | A MEDIAS | `pay-schedules/sql/001_schedules.sql`; sin verificador de deriva |
| P5.H3.M2 | HECHO | `mandates.spec.ts` |
| P5.H3.M3 | HECHO | `executor.spec.ts` («ejecución única», 5 corridas) |
| P5.H3.M4 | HECHO | `executor.spec.ts` («comisiones programadas») |
| P5.H3.M5 | HECHO contra [DOBLE] de pay-ledger | `executor.spec.ts` («kill-test y E5»); el E2E real es de la ola 4 |
| P5.H3.M6 | HECHO | `executor.spec.ts` («aviso») |

| Archivo | Qué es |
|---|---|
| `pay-merchants-test-x5.txt`, `pay-schedules-test-x5.txt`, `pay-merchants-risk-test-x5.txt`, `pay-risk-test-x5.txt` | 5 corridas completas de cada suite (las de concurrencia y ejecución única cuentan) |
| `pay-*-verbose.txt` | Corrida con resumen por suite |
| `gates-typecheck-build.txt`, `gates-lint-p5.txt`, `gates-lint-raiz.txt` | Typecheck, build y lint (el `yarn lint` raíz tiene errores de `pay-settlement` y `pay-webhooks`, no de P5) |

## No cubierto
- Contra el `pay-ledger` REAL (P2), `pay-edge` REAL (P1) y `pay-payments` REAL (P3); NATS real para los consumidores `merchant.*` de `pay-schedules`.
- Listas de sanciones vigentes (OFAC/UE/UK/ONU) y la latencia de Watchman con carga real.
- Verificación de deriva contra el modelo (D-18); almacén de objetos de producción; verificador de operadores real.
- Pruebas visuales: no aplican (solo backend).
