/**
 * Fechas de los mandatos. Todo es calendario de La Paz (UTC-4 todo el año: Bolivia no usa horario de verano), sin zonas
 * horarias del sistema. Las fechas se manejan como cadenas `AAAA-MM-DD` y los periodos como `AAAA-MM`.
 */
export type IsoDate = string;
export type Period = string;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Fecha de La Paz en el instante `now`. */
export function laPazDate(now: Date): IsoDate {
  return new Date(now.getTime() - 4 * 3600_000).toISOString().slice(0, 10);
}

/** ¿Es una fecha real del calendario (no el 31 de abril ni el 29 de febrero de un año común)? */
export function isRealDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Primera fecha `>= start` cuyo día del mes es `dayOfMonth` (1–28, existe todos los meses). */
export function firstDue(start: IsoDate, dayOfMonth: number): IsoDate {
  const [y, m, d] = start.split('-').map(Number);
  if (d <= dayOfMonth) return `${y}-${pad(m)}-${pad(dayOfMonth)}`;
  return m === 12 ? `${y + 1}-01-${pad(dayOfMonth)}` : `${y}-${pad(m + 1)}-${pad(dayOfMonth)}`;
}

/** La fecha del mes siguiente con el mismo día. */
export function nextDue(current: IsoDate): IsoDate {
  const [y, m, d] = current.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-${pad(d)}` : `${y}-${pad(m + 1)}-${pad(d)}`;
}

/** Periodo `AAAA-MM` de una fecha. */
export const periodOf = (date: IsoDate): Period => date.slice(0, 7);
