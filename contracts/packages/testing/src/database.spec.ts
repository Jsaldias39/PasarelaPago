import { createIsolatedDatabase } from './index';

describe('createIsolatedDatabase — tamaño del pool', () => {
  it('CORRECTO: por defecto 60, y `max` lo cambia', async () => {
    const [byDefault, small] = [await createIsolatedDatabase([]), await createIsolatedDatabase([], { max: 3 })];
    try {
      expect((byDefault.pool as unknown as { options: { max: number } }).options.max).toBe(60);
      expect((small.pool as unknown as { options: { max: number } }).options.max).toBe(3);
    } finally {
      await byDefault.drop();
      await small.drop();
    }
  });

  it('LÍMITE: PAY_TEST_POOL_MAX cambia el valor por defecto; la opción manda sobre el entorno', async () => {
    process.env.PAY_TEST_POOL_MAX = '7';
    try {
      const fromEnv = await createIsolatedDatabase([]);
      const explicit = await createIsolatedDatabase([], { max: 2 });
      try {
        expect((fromEnv.pool as unknown as { options: { max: number } }).options.max).toBe(7);
        expect((explicit.pool as unknown as { options: { max: number } }).options.max).toBe(2);
      } finally {
        await fromEnv.drop();
        await explicit.drop();
      }
    } finally {
      delete process.env.PAY_TEST_POOL_MAX;
    }
  });

  it.each([0, -1, 1.5, 401])('INVÁLIDO: max=%p se rechaza antes de abrir nada', async (max) => {
    await expect(createIsolatedDatabase([], { max })).rejects.toThrow(RangeError);
  });
});
