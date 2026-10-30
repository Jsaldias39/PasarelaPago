import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * `settlement.mode` y el guardia contra el doble del modo B en producción (P2.H2.M8, REQ-P2-7): el servicio arranca con
 * `settlement.mode=acquirer` en sandbox y el reporte de salud DICE que el riel es un doble; con `PAY_MODE=live` se niega a arrancar.
 */
const KEYS = ['SETTLEMENT_MODE', 'PAY_MODE', 'SETTLEMENT_TRANSFER_CONNECTOR', 'IDEMPOTENCY_MASK_KEY'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('settlement.mode en el arranque', () => {
  it('modo A (por defecto): el reporte de salud dice banco real, no simulado', async () => {
    delete process.env.SETTLEMENT_MODE;
    const app = await boot();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.info.settlement).toMatchObject({ status: 'up', mode: 'bank', rail: 'bank_transfer', simulated: false, payMode: 'sandbox' });
    await app.close();
  });

  it('modo B en sandbox: arranca y el reporte dice que el riel es un doble (simulated: true)', async () => {
    process.env.SETTLEMENT_MODE = 'acquirer';
    const app = await boot();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.info.settlement).toMatchObject({ mode: 'acquirer', rail: 'acquirer_settlement', simulated: true, payMode: 'sandbox' });
    await app.close();
  });

  it('modo B con PAY_MODE=live: NO arranca', async () => {
    process.env.SETTLEMENT_MODE = 'acquirer';
    process.env.PAY_MODE = 'live';
    process.env.IDEMPOTENCY_MASK_KEY = 'clave-sintetica-de-prueba-0123456789abcdef'; // bajo live el almacén de idempotencia la exige (S-02): así la prueba sigue midiendo SU guardia
    await expect(boot()).rejects.toThrow(/acquirer.*live/);
  });

  it('PAY_MODE=live con el conector `mock`: NO arranca', async () => {
    process.env.PAY_MODE = 'live';
    process.env.IDEMPOTENCY_MASK_KEY = 'clave-sintetica-de-prueba-0123456789abcdef'; // bajo live el almacén de idempotencia la exige (S-02): así la prueba sigue midiendo SU guardia
    process.env.SETTLEMENT_TRANSFER_CONNECTOR = 'mock';
    await expect(boot()).rejects.toThrow(/mock.*live/);
  });
});
