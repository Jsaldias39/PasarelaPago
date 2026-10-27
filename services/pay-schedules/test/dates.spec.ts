import { firstDue, isRealDate, laPazDate, nextDue, periodOf } from '../src/dates';

describe('fechas de los mandatos (calendario de La Paz, UTC-4)', () => {
  it('laPazDate: a las 03:59 UTC todavía es el día anterior; a las 04:00 UTC ya es el nuevo', () => {
    expect(laPazDate(new Date('2026-03-10T03:59:59Z'))).toBe('2026-03-09');
    expect(laPazDate(new Date('2026-03-10T04:00:00Z'))).toBe('2026-03-10');
    expect(laPazDate(new Date('2026-01-01T02:00:00Z'))).toBe('2025-12-31');
    expect(laPazDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
  });

  it.each([
    ['2026-03-10', 15, '2026-03-15'],
    ['2026-03-15', 15, '2026-03-15'], // el mismo día cuenta
    ['2026-03-16', 15, '2026-04-15'],
    ['2026-12-20', 5, '2027-01-05'], // cruza el año
    ['2026-01-31', 28, '2026-02-28'],
    ['2026-01-29', 28, '2026-02-28'],
    ['2026-02-01', 1, '2026-02-01'],
  ])('firstDue(%s, día %i) = %s', (start, day, expected) => {
    expect(firstDue(start, day)).toBe(expected);
  });

  it('nextDue avanza un mes y cruza el año; el día 28 existe en todos los meses (incluido febrero de un año no bisiesto)', () => {
    expect(nextDue('2026-01-28')).toBe('2026-02-28');
    expect(nextDue('2026-02-28')).toBe('2026-03-28');
    expect(nextDue('2026-12-15')).toBe('2027-01-15');
    let date = '2026-01-28';
    const seen: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      seen.push(date);
      date = nextDue(date);
      expect(isRealDate(date)).toBe(true);
    }
    expect(new Set(seen.map(periodOf)).size).toBe(24); // un periodo por mes, sin repetir ni saltar
  });

  it('isRealDate rechaza fechas que no existen', () => {
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10', '2026-3-10', '2026-03-10T00:00:00Z', 'x', '']) expect({ bad, ok: isRealDate(bad) }).toEqual({ bad, ok: false });
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-12-31')).toBe(true);
  });

  it('periodOf toma AAAA-MM', () => {
    expect(periodOf('2026-03-15')).toBe('2026-03');
  });
});
