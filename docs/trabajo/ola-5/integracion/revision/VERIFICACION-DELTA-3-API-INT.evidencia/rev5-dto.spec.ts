
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CloseGatewayDispatchDto } from '../dto/payment-gateway-dispatch.dto';

const out = (m: string) => process.stdout.write(`R5D> ${m}\n`);
const check = async (reason: unknown) =>
  (await validate(plainToInstance(CloseGatewayDispatchDto, { reason }))).length === 0;

describe('REV5 D11 motivo', () => {
  it('muestras legitimas y no legitimas en espanol', async () => {
    const samples: [string, unknown][] = [
      ['tildes y ñ', 'Verificación hecha: el cliente no tenía cobro pendiente. Año 2026.'],
      ['signos de apertura', '¿Existe cobro? ¡No! Confirmado en la consola de la pasarela'],
      ['parentesis y comillas rectas', 'Revisado con "soporte" (ticket 4521) y sin cobro creado'],
      ['numeral #', 'Revisado en la consola de la pasarela, ticket #4521'],
      ['guion largo', 'Sin cobro en la pasarela — verificado por soporte'],
      ['comillas curvas', 'Soporte confirmó “sin cobro” en la pasarela'],
      ['apostrofe tipografico', 'Confirmado por soporte, no hay cobro d’origen'],
      ['puntos suspensivos unicode', 'Sin cobro en la pasarela… verificado por soporte'],
      ['arroba/correo', 'Confirmado con soporte@pasarela.bo que no hay cobro'],
      ['ampersand', 'Soporte & finanzas confirmaron que no hay cobro'],
      ['signo mas', 'Sin cobro creado; reintento + conciliación manual hecha'],
      ['n°', 'Operación N° 4521 verificada: sin cobro creado'],
      ['dolar', 'Sin cobro de $ 150 en la consola de la pasarela'],
      ['salto de linea', 'Verificado en la consola\nsin cobro creado en la pasarela'],
      ['9 letras', 'abcdefghi'],
      ['10 letras', 'abcdefghij'],
      ['10 digitos', '1234567890'],
      ['diez espacios', '          '],
      ['numero', 12345678901234],
      ['objeto', { a: 'xxxxxxxxxxxxxxxx' }],
      ['json', '{"a":"xxxxxxxxxxxxxxxx"}'],
      ['300 letras', 'a'.repeat(300)],
      ['301 letras', 'a'.repeat(301)],
      ['con recorte', '   Verificado en consola: no hay cobro   '],
    ];
    const res: string[] = [];
    for (const [n, v] of samples) res.push(`${n}=${(await check(v)) ? 'ACEPTA' : 'rechaza'}`);
    out(`MOTIVO: ${res.join(' | ')}`);
  });

  it('coste de la expresion con 1 MB de entrada (limite del cuerpo)', async () => {
    const t = (s: string) => { const a = process.hrtime.bigint(); void check(s); return Number(process.hrtime.bigint() - a) / 1e6; };
    const big = ['a'.repeat(1_000_000), ' '.repeat(1_000_000), '1'.repeat(1_000_000), ('a ' ).repeat(500_000), '.'.repeat(1_000_000)];
    out(`COSTE 1MB (ms): ${big.map((b) => t(b).toFixed(1)).join(' ')}`);
  });
});
