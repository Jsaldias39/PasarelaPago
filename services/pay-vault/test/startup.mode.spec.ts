import { assertBackendAllowed, loadConfig, parsePayMode } from '../src/config';

/** Tanda 2c: `PAY_MODE` explícito, sin valor por defecto, y bajo `live` ningún doble (D-26). */
const BASE = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p', VAULT_BACKEND: 'fake' };

describe('PAY_MODE en pay-vault', () => {
  it('correcto: sandbox arranca con el doble', () => {
    const config = loadConfig({ ...BASE, PAY_MODE: 'sandbox' });
    expect(config.payMode).toBe('sandbox');
    expect(config.backend).toBe('fake');
  });

  it('límite: sin PAY_MODE (o vacío) NO arranca y el mensaje dice qué hacer; no hay valor por defecto', () => {
    expect(() => loadConfig({ ...BASE })).toThrow(/PAY_MODE debe ser «sandbox» o «live» y no tiene valor por defecto \(llegó: sin definir\)/);
    expect(() => loadConfig({ ...BASE, PAY_MODE: '' })).toThrow(/sin definir/);
  });

  it.each(['Live', 'LIVE', 'production', 'test', ' live', 'sandbox '])('inválido: %j se rechaza (no se normaliza)', (value) => {
    expect(() => parsePayMode(value)).toThrow(/PAY_MODE debe ser «sandbox» o «live»/);
    expect(() => loadConfig({ ...BASE, PAY_MODE: value })).toThrow(/PAY_MODE/);
  });

  it('inválido: live con VAULT_BACKEND=fake se niega a arrancar, con un mensaje que nombra el doble', () => {
    expect(() => loadConfig({ ...BASE, PAY_MODE: 'live' })).toThrow('PAY_MODE=live: VAULT_BACKEND=fake es un doble; pay-vault se niega a arrancar');
  });

  it('segunda barrera: la regla que usa el módulo prohíbe el doble bajo live y lo deja en sandbox', () => {
    expect(() => assertBackendAllowed('live', 'fake')).toThrow(/se niega a arrancar/);
    expect(() => assertBackendAllowed('sandbox', 'fake')).not.toThrow();
  });

  it('inválido: un backend desconocido sigue rechazándose antes de mirar el modo', () => {
    expect(() => loadConfig({ ...BASE, PAY_MODE: 'sandbox', VAULT_BACKEND: 'otro' })).toThrow(/VAULT_BACKEND inválido/);
  });
});
