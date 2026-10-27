# Carril P4 — Conectores, ruteo y QR

> **Estado:** `EN CURSO` (ola 1) · **AVANCE: 12 / 22 — 54,5 %** · **Peldaño:** `TESTED` en lo marcado HECHO (pruebas de integración contra Postgres y NATS reales y contra dobles declarados; sin banco real); `UNKNOWN` en H4
> **Predecesor:** P1.H1 (plataforma y plantilla).
> **Carpetas del monorepo:** `services/pay-connectors/`, `services/pay-qr/` · esquema en `mantra-core-health-model`.
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md)

**Skills:** `backend-development`, `nestjs-development`, `error-handling-contract`, `concurrency-and-locking`,
`environment-secrets-config`, `security-guardrails`, `api-testing`, `edge-case-data-catalog`,
`synthetic-test-data-generation`, `anti-hallucination-guard`, `evidence-and-verification`.

## Resultado observable

`pay-payments` cobra por cualquier riel (QR interoperable y tarjeta del Banco Mercantil Santa Cruz, transferencia y, más adelante,
otros bancos) a través de **una sola interfaz**. El ruteo elige el riel por reglas, los callbacks del
proveedor se aceptan solo si son auténticos, y cuando un callback no llega, el estado se averigua
igual. La pasarela emite su propio QR EMVCo, que cualquier app bancaria boliviana lee.

**Kill-test:** mandar al endpoint de callback un cuerpo válido con la firma alterada, y después el
mismo callback legítimo 3 veces. Si el primero se acepta, o si el legítimo produce más de un
`connector.transaction.status_changed` con efecto, no está hecho. Y generar un QR y cambiarle un
carácter: si el CRC no lo detecta, tampoco.

## Contratos

- **Expone:** `internal/connectors/v1` (charges, refunds, status, statements), eventos
  `connector.transaction.status_changed` y `connector.health.*`, y la interfaz `Connector` (SDK
  interno para escribir adaptadores).
- **Consume:** credenciales de OpenBao; `fee_schedule.published` (P5) solo para el ruteo por costo.

## Criterios

- **REQ-P4-1** — Dado un callback con firma inválida o desde un endpoint no registrado, cuando llega, entonces se responde `401` y no se publica nada (reciclando `webhook-secret.resolver.ts` y `callback-endpoint.policy.ts`). — `MISSING`
- **REQ-P4-2** — Dado el mismo callback N veces, cuando llega, entonces se publica un evento con el mismo `event_id` (idempotente por `(connector, provider_event_id)`). — `MISSING`
- **REQ-P4-3** — Dada una regla «tarjeta → Mercantil; si está *down*, el cobro se rechaza con `connector_unavailable` y se reintenta por consulta de estado», cuando el Mercantil falla su *health check*, entonces el cobro no se pierde ni se duplica. El ruteo queda listo para un segundo banco (D-05). — `MISSING`
- **REQ-P4-4** — Dado un QR emitido, cuando se decodifica, entonces respeta EMVCo MPM: `000201` al inicio, `6304` + CRC16 válido al final, monto, moneda `068` (BOB) y la plantilla de cuenta del comercio con su GUID. — `MISSING`
- **REQ-P4-5** — Dado un cobro sin callback a los T segundos, cuando corre el *poller*, entonces consulta el estado al proveedor y publica el resultado. — `MISSING`
- **REQ-P4-6** — Dado cualquier log, traza o error, cuando se inspecciona, entonces no contiene credenciales del conector ni datos personales del pagador. — `MISSING`
- **REQ-P4-7** — Dado el perfil QR boliviano, cuando se confirma contra la especificación oficial del QR interoperable (BCB / banco adquirente), entonces los campos nacionales quedan documentados con su fuente. — `AMBIGUOUS` (hace falta el documento oficial)

## H1 — Interfaz de conector y simulador (olas 0 y 1)

**CA:** Dado `pay-payments`, cuando cobra por el simulador, entonces ejerce los mismos caminos (éxito, fallo, demora, duplicado, reorden) que va a tener un PSP real.
**DoD:** REQ-P4-1, 2 y 5 contra el simulador.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P4.H1.M1 | **Spike**: APIs del Banco Mercantil Santa Cruz (QR interoperable, adquirencia de tarjetas, extractos y cuenta recaudadora) y especificación del QR interoperable; lista de lo que falta y de lo que hay que pedirle al banco | Documento de brechas con fuentes | `evidencia/spike-rieles.md` → [spike](../../spikes/banco-mercantil.md): no hay API pública; **15 pedidos al banco** (`DISCOVERED`) | HECHO |
| P4.H1.M2 | Esquema `pay_connectors` en el modelo (desde `gateway_connections`, `provider_api_operations`, `provider_api_attempts`, `provider_callback_endpoints` y `provider_callback_events`) | Sin deriva | Verificador de deriva | A MEDIAS — SQL de referencia aplicado dos veces a un esquema vacío, sin índices de nombre generado ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H1.M2.txt)); falta declararlo en `mantra-core-health-model` (D-18) y el verificador de deriva contra el modelo y el ORM |
| P4.H1.M3 | Interfaz `Connector` (`createCharge`, `refund`, `getStatus`, `verifyCallback`, `fetchStatement`) + registro de adaptadores (patrón de Hyperswitch / Kill Bill) | Agregar un adaptador no toca el núcleo | Test de registro | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H1.M3.txt)) |
| P4.H1.M4 | Conector **simulador**, configurable por escenario (éxito, rechazo, demora, duplicado, reorden, *down*) | Cada escenario es reproducible por semilla | Test por escenario | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H1.M4.txt)) |
| P4.H1.M5 | Endpoint de callbacks: verificación reciclada + deduplicación + outbox | REQ-P4-1 y 2 | Test de integración | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H1.M5.txt)) |
| P4.H1.M6 | *Poller* de estado con *backoff* y límite | REQ-P4-5 | Test pegado | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H1.M6.txt)) |

## H2 — Ruteo y rieles reales (olas 1 a 3)

**CA:** Dado un cobro, cuando hay varios rieles posibles, entonces se elige por regla y, ante una caída, se pasa al siguiente sin intervención humana.
**DoD:** REQ-P4-3 + adaptadores del Banco Mercantil Santa Cruz contra su ambiente de pruebas (ola 3).

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P4.H2.M1 | Motor de reglas de ruteo (canal, monto, costo, salud), declarativo y versionado | REQ-P4-3 | Test pegado | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H2.M1.txt)) |
| P4.H2.M2 | *Health checks* por conector + eventos `connector.health.*` | Un conector caído sale del ruteo | Test pegado | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H2.M2.txt)) |
| P4.H2.M3 | Adaptador **Mercantil · tarjeta** (adquirencia: autorización, captura, anulación, reembolso, callback y consulta de estado; tokens de su página de pago o de `pay-vault`) | Contra el sandbox, o declarado `BLOQUEADO` con el contrato simulado en los 3 niveles | Salida contra el sandbox | BLOQUEADO — sin documentación pública del Mercantil (`docs/spikes/banco-mercantil.md`); lo destraban los 15 pedidos al banco y Q-01/Q-11. Contra el simulador [DOBLE] en 3 niveles ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H1.M4.txt)) |
| P4.H2.M4 | Adaptador **Mercantil · QR interoperable** (emisión con la cuenta recaudadora, callback, consulta de estado) | Ídem | Ídem | BLOQUEADO — ídem M3 (emisión QR con cuenta recaudadora, callback y consulta de estado del banco) |
| P4.H2.M5 | Extractos: `fetchStatement` en `camt.053` o CSV para P2 | El extracto del simulador cuadra con sus cobros | Test pegado | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H2.M5.txt)) |
| P4.H2.M6 | Credenciales en OpenBao con rotación; nada de secretos en variables de imagen | REQ-P4-6; `git grep` de secretos → 0 | Salida pegada | A MEDIAS — `SecretProvider` fail-closed con espacio por conector y rotación sin corte, REQ-P4-6 probado (logs, respuestas, eventos y base sin secretos ni datos del pagador) y `git grep` sin secretos en `src/` ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H2.M6.txt), [grep](../trabajo/ola-1/P4/evidencia/P4.H2.M6-grep.txt)); falta OpenBao real (no corre en el entorno de trabajo) |
| P4.H2.M7 | Adaptador **transferencia bancaria**: instrucciones de pago con referencia única, y confirmación cuando la línea aparece en el extracto | Una línea con la referencia confirma el intento; una sin referencia va a excepción | Test con extracto del simulador | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H2.M7.txt)) |

## H3 — `pay-qr` (olas 1 y 2)

**CA:** Dado un intento, cuando se pide un QR, entonces se emite un QR EMVCo válido, con vencimiento, que se anula si el intento expira.
**DoD:** REQ-P4-4 con vectores de prueba.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P4.H3.M1 | Codificador y decodificador TLV EMVCo MPM + CRC16 (CCITT-FALSE: verificar contra la especificación oficial) | Ida y vuelta sin pérdida; un carácter cambiado → CRC inválido | Tests con vectores pegados | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H3.M1.txt)) |
| P4.H3.M2 | QR dinámico por intento (monto + referencia) y estático por comercio; vencimiento y anulación | Un QR vencido se rechaza en la conciliación del callback | Test pegado | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H3.M2.txt)) |
| P4.H3.M3 | Perfil boliviano documentado con su fuente (REQ-P4-7) | Cada campo nacional con su fuente | `docs/perfil-qr-bo.md` | A MEDIAS — `services/pay-qr/docs/perfil-qr-bo.md` escrito con la fuente de cada campo, pero sin acceso al manual oficial del BCB/banco: REQ-P4-7 sigue `AMBIGUOUS` |
| P4.H3.M4 | Imagen PNG/SVG del QR para el comercio (sin datos personales) | Lo lee una app de lectura estándar | Captura de la lectura en `evidencia/` | HECHO ([evidencia](../trabajo/ola-1/P4/evidencia/P4.H3.M4.txt)) |

## H4 — Banco simulado `pay-mockbank` (ola 4, D-26)

**CA:** Dado el sistema sin credenciales del banco, cuando se cobra por QR o tarjeta, entonces un banco simulado con la misma interfaz que el real responde, calla, se equivoca o se cae según el importe, y el cobro llega a su estado final.
**DoD:** E1–E3 y E8 en verde contra `pay-mockbank`; tests de contrato idénticos para el simulador y el conector real.

| ID | Microtarea | CA (binario) | DoD (comando de verificación) | Estado |
|---|---|---|---|---|
| P4.H4.M1 | Suite de tests de contrato **parametrizada por conector** (`mock`, `mercantil_qr`, `mercantil_card`, `bank_transfer`) | Corre completa contra el simulador y queda lista para el real | `yarn workspace pay-connectors test:contract` → verde con `CONNECTOR=mock` | TODO |
| P4.H4.M2 | `pay-mockbank`: servicio independiente con su propia base que expone lo que expondría el banco (pago de QR, autorización/captura/anulación de tarjeta, extracto `camt.053`/CSV, callbacks firmados) **sin inventar campos del banco real** (Q-01, Q-11) | Arranca `healthy` y cumple `internal-connectors-v1` | `curl /health/ready` + tests de contrato | TODO |
| P4.H4.M3 | Escenarios **deterministas por importe**, documentados en una tabla: aprobado, rechazado, demorado, callback duplicado, callback fuera de orden, callback perdido, banco caído, extracto con diferencia | Un test por escenario con su importe fijo | `yarn workspace pay-mockbank test` → un caso por fila de la tabla | TODO |
| P4.H4.M4 | Pagador simulado (`mockbank pay <qr>`) que «paga» un QR emitido por la pasarela | E1 completo sin intervención manual | E1 en verde | TODO |
| P4.H4.M5 | Guardia de modo: con `PAY_MODE=live` el conector `mock` no carga y el arranque falla; en sandbox toda respuesta lleva `X-Pay-Mode: sandbox` | Las dos condiciones | Test pegado | TODO |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| PSP / banco real | Manual del proveedor | Cobro confirmado | Callback a los 59 min de un QR de 60 min; callback duplicado | Firma inválida; estado desconocido → `contradiccion` para conciliación |
| Especificación oficial del QR boliviano | EMVCo MPM + perfil nacional | QR estándar | Monto máximo; referencia de longitud máxima | Plantilla sin GUID → rechazada |

**Lo que queda contra dobles hasta tener acceso:** el ambiente de pruebas del Banco Mercantil Santa Cruz. Se declara
así en el reporte. No es `BLOQUEADO`: el contrato está escrito y simulado.

## Gates y entrega

Gates de §7 del maestro. PRs contra `dev`, mergeables (regla 35).
