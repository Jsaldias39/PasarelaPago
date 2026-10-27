# Carril P4 — Conectores, ruteo y QR

> **Estado:** `TODO` · **AVANCE: 0 / 17 — 0,0 %** · **Peldaño:** `UNKNOWN`
> **Predecesor:** P1.H1 (plataforma y plantilla).
> **Carpetas del monorepo:** `services/pay-connectors/`, `services/pay-qr/` · esquema en `mantra-core-health-model`.
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md)

**Skills:** `backend-development`, `nestjs-development`, `error-handling-contract`, `concurrency-and-locking`,
`environment-secrets-config`, `security-guardrails`, `api-testing`, `edge-case-data-catalog`,
`synthetic-test-data-generation`, `anti-hallucination-guard`, `evidence-and-verification`.

## Resultado observable

`pay-payments` cobra por cualquier riel (QR interoperable de un banco, Libélula y, más adelante,
otros) a través de **una sola interfaz**. El ruteo elige el riel por reglas, los callbacks del
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
- **REQ-P4-3** — Dada una regla «QR → banco X; si X está *down*, Libélula», cuando X falla su *health check*, entonces el siguiente cobro va a Libélula. — `MISSING`
- **REQ-P4-4** — Dado un QR emitido, cuando se decodifica, entonces respeta EMVCo MPM: `000201` al inicio, `6304` + CRC16 válido al final, monto, moneda `068` (BOB) y la plantilla de cuenta del comercio con su GUID. — `MISSING`
- **REQ-P4-5** — Dado un cobro sin callback a los T segundos, cuando corre el *poller*, entonces consulta el estado al proveedor y publica el resultado. — `MISSING`
- **REQ-P4-6** — Dado cualquier log, traza o error, cuando se inspecciona, entonces no contiene credenciales del conector ni datos personales del pagador. — `MISSING`
- **REQ-P4-7** — Dado el perfil QR boliviano, cuando se confirma contra la especificación oficial del QR interoperable (BCB / banco adquirente), entonces los campos nacionales quedan documentados con su fuente. — `AMBIGUOUS` (hace falta el documento oficial)

## H1 — Interfaz de conector y simulador (olas 0 y 1)

**CA:** Dado `pay-payments`, cuando cobra por el simulador, entonces ejerce los mismos caminos (éxito, fallo, demora, duplicado, reorden) que va a tener un PSP real.
**DoD:** REQ-P4-1, 2 y 5 contra el simulador.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P4.H1.M1 | **Spike**: manual de Libélula (ya alineado en `libelula-payment-alignment.md`) y especificación del QR interoperable; lista de lo que falta | Documento de brechas con fuentes | `evidencia/spike-rieles.md` | TODO |
| P4.H1.M2 | Esquema `pay_connectors` en el modelo (desde `gateway_connections`, `provider_api_operations`, `provider_api_attempts`, `provider_callback_endpoints` y `provider_callback_events`) | Sin deriva | Verificador de deriva | TODO |
| P4.H1.M3 | Interfaz `Connector` (`createCharge`, `refund`, `getStatus`, `verifyCallback`, `fetchStatement`) + registro de adaptadores (patrón de Hyperswitch / Kill Bill) | Agregar un adaptador no toca el núcleo | Test de registro | TODO |
| P4.H1.M4 | Conector **simulador**, configurable por escenario (éxito, rechazo, demora, duplicado, reorden, *down*) | Cada escenario es reproducible por semilla | Test por escenario | TODO |
| P4.H1.M5 | Endpoint de callbacks: verificación reciclada + deduplicación + outbox | REQ-P4-1 y 2 | Test de integración | TODO |
| P4.H1.M6 | *Poller* de estado con *backoff* y límite | REQ-P4-5 | Test pegado | TODO |

## H2 — Ruteo y rieles reales (olas 1 a 3)

**CA:** Dado un cobro, cuando hay varios rieles posibles, entonces se elige por regla y, ante una caída, se pasa al siguiente sin intervención humana.
**DoD:** REQ-P4-3 + adaptador Libélula contra su sandbox (ola 3).

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P4.H2.M1 | Motor de reglas de ruteo (canal, monto, costo, salud), declarativo y versionado | REQ-P4-3 | Test pegado | TODO |
| P4.H2.M2 | *Health checks* por conector + eventos `connector.health.*` | Un conector caído sale del ruteo | Test pegado | TODO |
| P4.H2.M3 | Adaptador **Libélula** (registro de deuda → checkout → callback → consulta de estado) | Contra el sandbox, o declarado `BLOQUEADO` con el contrato simulado en los 3 niveles | Salida contra el sandbox | TODO |
| P4.H2.M4 | Adaptador **QR interoperable** del banco adquirente | Ídem | Ídem | TODO |
| P4.H2.M5 | Extractos: `fetchStatement` en `camt.053` o CSV para P2 | El extracto del simulador cuadra con sus cobros | Test pegado | TODO |
| P4.H2.M6 | Credenciales en OpenBao con rotación; nada de secretos en variables de imagen | REQ-P4-6; `git grep` de secretos → 0 | Salida pegada | TODO |
| P4.H2.M7 | Adaptador **transferencia bancaria**: instrucciones de pago con referencia única, y confirmación cuando la línea aparece en el extracto | Una línea con la referencia confirma el intento; una sin referencia va a excepción | Test con extracto del simulador | TODO |

## H3 — `pay-qr` (olas 1 y 2)

**CA:** Dado un intento, cuando se pide un QR, entonces se emite un QR EMVCo válido, con vencimiento, que se anula si el intento expira.
**DoD:** REQ-P4-4 con vectores de prueba.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P4.H3.M1 | Codificador y decodificador TLV EMVCo MPM + CRC16 (CCITT-FALSE: verificar contra la especificación oficial) | Ida y vuelta sin pérdida; un carácter cambiado → CRC inválido | Tests con vectores pegados | TODO |
| P4.H3.M2 | QR dinámico por intento (monto + referencia) y estático por comercio; vencimiento y anulación | Un QR vencido se rechaza en la conciliación del callback | Test pegado | TODO |
| P4.H3.M3 | Perfil boliviano documentado con su fuente (REQ-P4-7) | Cada campo nacional con su fuente | `docs/perfil-qr-bo.md` | TODO |
| P4.H3.M4 | Imagen PNG/SVG del QR para el comercio (sin datos personales) | Lo lee una app de lectura estándar | Captura de la lectura en `evidencia/` | TODO |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| PSP / banco real | Manual del proveedor | Cobro confirmado | Callback a los 59 min de un QR de 60 min; callback duplicado | Firma inválida; estado desconocido → `contradiccion` para conciliación |
| Especificación oficial del QR boliviano | EMVCo MPM + perfil nacional | QR estándar | Monto máximo; referencia de longitud máxima | Plantilla sin GUID → rechazada |

**Lo que queda contra dobles hasta tener acceso:** los sandboxes de Libélula y del banco. Se declara
así en el reporte. No es `BLOQUEADO`: el contrato está escrito y simulado.

## Gates y entrega

Gates de §7 del maestro. PRs contra `dev`, mergeables (regla 35).
