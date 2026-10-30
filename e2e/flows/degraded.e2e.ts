import { existsSync } from 'node:fs';
import { StackBusyError, startStack, stopStack } from '../stack.ts';

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

  it('un segundo stack mientras hay uno vivo se rechaza con el candado (un solo stack a la vez) y dice QUIÉN lo tiene: su runId y su pid', async () => {
    const first = await startStack({ only: ['pay-qr'] });
    try {
      const error = await startStack({ only: ['pay-qr'] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StackBusyError);
      expect((error as StackBusyError).holder).toMatchObject({ runId: first.runId, pid: process.pid });
      expect((error as StackBusyError).message).toMatch(new RegExp(`^stack en uso por runId ${first.runId} pid ${process.pid} desde \\d{2}:\\d{2}`));
      // El perdedor no tocó nada: el primero sigue sano y con su candado.
      expect(first.lock.info.runId).toBe(first.runId);
      expect((await first.call('pay-qr', 'GET', '/health/ready')).status).toBe(200);
    } finally {
      await stopStack(first, { keepLogs: true });
    }
    expect(existsSync(first.lock.path)).toBe(false); // y al apagar, el candado queda libre
  });
});
