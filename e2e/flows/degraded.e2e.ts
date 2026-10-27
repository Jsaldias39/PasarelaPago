import { existsSync } from 'node:fs';
import { startStack, stopStack } from '../stack.ts';

/** El arnés mismo: un servicio que no arranca se informa con su motivo y su log, sin tumbar al resto; y todo se limpia. */
describe('arnés — arranques degradados', () => {
  it('una variable obligatoria que falta o un TigerBeetle inalcanzable dejan al servicio «no sano» con motivo y log, y el resto sigue', async () => {
    const stack = await startStack({
      only: ['pay-qr', 'pay-ledger', 'pay-risk'],
      readyTimeoutMs: 20_000,
      envOverrides: { 'pay-qr': { QR_ACCOUNT_GUID: null }, 'pay-ledger': { TB_ADDRESS: '127.0.0.1:1' } },
    });
    try {
      expect(stack.services['pay-risk'].healthy).toBe(true);

      const qr = stack.services['pay-qr'];
      expect(qr.healthy).toBe(false);
      expect(qr.started).toBe(false); // el proceso salió: falla rápido, como pide la regla 90.3.4
      expect(qr.error).toMatch(/terminó/);
      expect(qr.logTail).toBeTruthy();

      const ledger = stack.services['pay-ledger'];
      expect(ledger.healthy).toBe(false);
      expect(ledger.error).toBeTruthy();

      // lo que no se pidió no se levanta
      expect(stack.services['pay-edge'].error).toBe('no pedido');
      expect(stack.processes.has('pay-edge')).toBe(false);
    } finally {
      const report = await stopStack(stack, { keepLogs: true });
      expect(report.leftoverPids).toEqual([]);
      expect(existsSync(`${stack.runDir}/0_0.tigerbeetle`)).toBe(false);
    }
  });

  it('un segundo stack mientras hay uno registrado se rechaza (un solo stack a la vez)', async () => {
    const first = await startStack({ only: ['pay-qr'] });
    try {
      await expect(startStack({ only: ['pay-qr'] })).rejects.toThrow(/Ya hay un stack registrado/);
    } finally {
      await stopStack(first, { keepLogs: true });
    }
  });
});
