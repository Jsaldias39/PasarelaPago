import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from '../src/bank/scenarios';

// docs/trabajo/ola-2/P4/ESCENARIOS.md es lo que lee P2 para E4/E8: no puede desviarse de la tabla del código.
const doc = readFileSync(join(process.cwd(), '../../docs/trabajo/ola-2/P4/ESCENARIOS.md'), 'utf8');
const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? 'null') as { scenarios_by_cents: Record<string, number>; [key: string]: unknown } | null;

describe('ESCENARIOS.md coincide con src/bank/scenarios.ts', () => {
  it('cada fila de la tabla del código aparece en la tabla del documento con su importe de ejemplo', () => {
    for (const s of SCENARIOS) {
      const cents = String(s.cents).padStart(2, '0');
      const row = doc.split('\n').find((line) => line.startsWith(`| \`${cents}\` |`));
      expect(row).toBeDefined();
      expect(row).toContain(`\`${10000 + s.cents}\``);
    }
  });

  it('el bloque JSON asigna a cada escenario los mismos centavos que el código', () => {
    expect(json).not.toBeNull();
    expect(json?.scenarios_by_cents).toEqual(Object.fromEntries(SCENARIOS.map((s) => [s.scenario, s.cents])));
  });

  it('las constantes de E4/E8 son coherentes: el desvío del extracto resta Bs 1,00 y el importe equivocado de E8 difiere del correcto', () => {
    expect(json?.statement_mismatch_minor).toBe(100);
    expect(json?.qr_gross_matching).toBe(10000 + (SCENARIOS.find((s) => s.scenario === 'approved')?.cents ?? -1));
    expect(json?.qr_gross_statement_mismatch).toBe(10000 + (SCENARIOS.find((s) => s.scenario === 'statement_mismatch')?.cents ?? -1));
    expect(json?.bank_transfer_gross).not.toBe(json?.bank_transfer_wrong_amount);
    expect(Number(json?.available_before_cut) % 100).toBe(SCENARIOS.find((s) => s.scenario === 'approved')?.cents);
  });
});
