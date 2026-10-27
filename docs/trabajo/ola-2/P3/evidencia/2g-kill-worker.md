# Matar el worker en cada actividad (P3.H2.M8, tanda 2g)

Generado por `services/pay-payments/test/ola2.tanda2g.kill.spec.ts` contra Postgres, Temporal y NATS reales y los dobles de riesgo, conectores y ledger ([DOBLE]). SIGKILL real de un worker en proceso aparte con la orden EN VUELO (el doble ya aplicó el efecto y todavía no respondió); un worker nuevo retoma la saga. Cada fila es lo OBSERVADO.

| # | Actividad | Inyección | Observado |
|---|---|---|---|
| 1 | createCharge | SIGKILL con POST /charges aplicado y sin respuesta | processing → requires_action → succeeded; cargos creados: 1; asientos: 1; eventos terminales: 1 |
| 2 | resolveExpiry | SIGKILL con POST /charges/{id}/cancel aplicado y sin respuesta | requires_action → expired (no canceled); cargos creados: 1; asientos: 0; eventos terminales: payment_intent.expired |
| 3 | holdRefund | SIGKILL con POST /holds aplicado y sin respuesta | reembolso succeeded; retenciones: 1 (posted); devoluciones en el conector: 1; saldo 20000 → 16000 (una sola vez); eventos terminales: refund.succeeded |
| 4 | finishRefund | SIGKILL con POST /holds/{id}/post aplicado y sin respuesta | reembolso succeeded; retención posted (1 confirmación efectiva); 0 anulaciones; saldo 20000 → 17500 (una sola vez); eventos terminales: refund.succeeded |
| 5 | recordLedger (asiento) | SIGKILL con POST /transactions aplicado y sin respuesta | processing → succeeded; asientos: 1; eventos terminales: 1 |
| 6 | completeIntent (commit + evento) | worker muere tras el commit, antes de confirmar la actividad (simulado en proceso) | succeeded; asientos: 1; eventos terminales: 1; la actividad se repitió y no cambió nada |
| 7 | publicación (relé del outbox) | el relé publica a NATS y muere antes de marcar published_at | evento reintentado con el mismo id; mensajes en el bus: 1; marcado publicado: sí |
| 8 | señales | captured ×4 y authorized atrasado, todos juntos | succeeded; asientos: 1; eventos terminales: 1; contradicciones: 0 |
| 9 | señales | captured y luego failed en la misma ráfaga | succeeded; asientos: 1; eventos terminales: 1; contradicción registrada y publicada: 1 |
| 10 | señales | failed y luego captured en la misma ráfaga | failed; asientos: 0; eventos terminales: 1; contradicción registrada y publicada: 1 |
| 11 | señales (disputa) | resolve lost y resolve won en la misma ráfaga | lost (la primera); débitos del contracargo: 1; eventos: dispute.opened, dispute.lost |
