# Matar el worker en cada actividad (P3.H2.M8, tanda 2g)

Generado por `services/pay-payments/test/ola2.tanda2g.kill.spec.ts` contra Postgres, Temporal y NATS reales y los dobles de riesgo, conectores y ledger ([DOBLE]). SIGKILL real de un worker en proceso aparte con la orden EN VUELO (el doble ya aplicó el efecto y todavía no respondió); un worker nuevo retoma la saga. Cada fila es lo OBSERVADO.

| # | Actividad | Inyección | Observado |
|---|---|---|---|
| 1 | createCharge | SIGKILL con POST /charges aplicado y sin respuesta | processing → requires_action → succeeded; cargos creados: 1; asientos: 1; eventos terminales: 1 |
| 2 | holdRefund | SIGKILL con POST /holds aplicado y sin respuesta | reembolso succeeded; retenciones: 1 (posted); devoluciones en el conector: 1; saldo 20000 → 16000 (una sola vez); eventos terminales: refund.succeeded |
| 3 | finishRefund | SIGKILL con POST /holds/{id}/post aplicado y sin respuesta | reembolso succeeded; retención posted (1 confirmación efectiva); 0 anulaciones; saldo 20000 → 17500 (una sola vez); eventos terminales: refund.succeeded |
| 4 | recordLedger (asiento) | SIGKILL con POST /transactions aplicado y sin respuesta | processing → succeeded; asientos: 1; eventos terminales: 1 |
| 5 | publicación (relé del outbox) | el relé publica a NATS y muere antes de marcar published_at | evento reintentado con el mismo id; mensajes en el bus: 1; marcado publicado: sí |
| 6 | señales | captured ×4 y authorized atrasado, todos juntos | succeeded; asientos: 1; eventos terminales: 1; contradicciones: 0 |
| 7 | señales (disputa) | resolve lost y resolve won en la misma ráfaga | lost (la primera); débitos del contracargo: 1; eventos: dispute.opened, dispute.lost |
