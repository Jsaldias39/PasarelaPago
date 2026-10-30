import { CANARY, findLeaks } from './helpers/sensitive';

describe('el detector de PAN no confunde un UUID con una tarjeta (falso positivo visto en una corrida completa)', () => {
  // `a1b2c392-4683-4719-8466-2abcdef01234` lleva la corrida de dígitos «92-4683-4719-8466-2» (17 dígitos) que cumple Luhn por azar.
  const uuid = 'a1b2c392-4683-4719-8466-2abcdef01234';
  it('un UUID con una corrida de dígitos que cumple Luhn NO se marca…', () => {
    expect(findLeaks('fila', JSON.stringify({ id: uuid }))).toEqual([]);
  });
  it('…pero un PAN de verdad pegado a ese UUID, o con la forma de un PAN, SÍ', () => {
    expect(findLeaks('fila', `${uuid} ${CANARY.panDashed}`)).not.toEqual([]);
    expect(findLeaks('fila', `id=${uuid}; tarjeta 4111 1111 1111 1111`)).not.toEqual([]);
    expect(findLeaks('fila', '5500-0000-0000-0004')).not.toEqual([]); // otro número de prueba público (Mastercard)
  });
});
