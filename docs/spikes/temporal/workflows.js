// Spike P3.H1.M1 — PaymentWorkflow sintético.
// Pasos: (a) crear cobro → (b) esperar señal o vencimiento → (c) registrar en ledger (id idempotente)
//        → (d) notificar. Cada paso que deja un efecto registra su compensación; ante un fallo corren en orden inverso.
const { proxyActivities, defineSignal, setHandler, condition } = require('@temporalio/workflow');

const acts = proxyActivities({
  startToCloseTimeout: '8 seconds',
  retry: { maximumAttempts: 5, initialInterval: '500 milliseconds', backoffCoefficient: 1 },
});

const confirmSignal = defineSignal('confirmPayment');

async function PaymentWorkflow({ intentId, expireMs, failNotify }) {
  let confirmed = false;
  setHandler(confirmSignal, () => { confirmed = true; });

  const compensations = []; // se apilan en orden de ejecución y se corren al revés
  const compensated = [];
  const compensate = async () => {
    for (const { name, fn } of [...compensations].reverse()) {
      await fn();
      compensated.push(name);
    }
  };

  try {
    const chargeId = await acts.createCharge(intentId);                                  // (a)
    compensations.push({ name: 'cancelCharge', fn: () => acts.cancelCharge(intentId, chargeId) });

    const ok = await condition(() => confirmed, expireMs);                               // (b) señal o vencimiento
    if (!ok) {
      await compensate();
      return { status: 'expired', compensated };
    }

    const ledgerId = `ledger-${intentId}`;                                               // id derivado del intento → idempotente
    await acts.recordLedger(intentId, ledgerId);                                         // (c)
    compensations.push({ name: 'reverseLedger', fn: () => acts.reverseLedger(intentId, ledgerId) });

    await acts.notify(intentId, !!failNotify);                                           // paso final (puede fallar)
    return { status: 'succeeded', compensated };
  } catch (err) {
    await compensate();                                                                   // (d) compensaciones en orden inverso
    return { status: 'failed', compensated, error: String((err && err.cause && err.cause.message) || (err && err.message)) };
  }
}

module.exports = { PaymentWorkflow };
