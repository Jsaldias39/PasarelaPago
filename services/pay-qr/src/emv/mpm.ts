import { fromMinor } from '@pay/money';
import { crcHex } from './crc16';
import { decodeTlv, EmvFormatError, encodeTlv, type Tlv } from './tlv';

/**
 * EMV QRCPS Merchant-Presented Mode (MPM): armado y lectura del payload.
 *
 * Solo se usan los objetos genéricos de EMVCo. La plantilla de cuenta del comercio (etiquetas 26 a 51) es de definición del
 * operador: acá lleva un GUID configurable (`00`) y la referencia del comercio (`01`). **No es el perfil del QR interoperable
 * boliviano**: ese perfil no está publicado en una fuente que se haya podido verificar (docs/spikes/banco-mercantil.md) y
 * queda como pregunta abierta (Q-01, Q-11). Un QR emitido con este perfil provisional NO es interoperable todavía.
 */

/** Moneda ISO 4217 numérica de v1 (D-06: solo bolivianos). */
export const CURRENCY_BOB = '068';
export const COUNTRY_BO = 'BO';
/** MCC desconocido: `0000`, como en los payloads publicados cuando no se informa categoría. */
export const MCC_UNKNOWN = '0000';

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const REFERENCE = /^[A-Za-z0-9]{1,25}$/;

export interface MpmInput {
  /** `static`: reutilizable, sin monto. `dynamic`: un cobro, con monto y referencia. */
  readonly kind: 'static' | 'dynamic';
  /** GUID del operador en la plantilla de cuenta. Lo asigna el banco o el regulador: viene de la configuración, no del código. */
  readonly accountGuid: string;
  /** Referencia opaca del comercio dentro de la plantilla (por ejemplo `mc_…`). */
  readonly merchantAccountRef: string;
  readonly merchantName: string;
  readonly merchantCity: string;
  readonly mcc?: string;
  /** Solo `dynamic`; se escribe con 2 decimales. */
  readonly amountMinor?: bigint;
  /** Solo `dynamic`: referencia con la que se concilia el pago (etiqueta 62/05). Para `static` va `***`. */
  readonly referenceLabel?: string;
}

/** Deja el texto en ASCII imprimible: quita tildes y rechaza lo que no se pueda representar (las longitudes EMV son en caracteres). */
export function toEmvText(text: string, max: number, field: string): string {
  const ascii = text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (ascii.length === 0 || !PRINTABLE_ASCII.test(ascii)) throw new EmvFormatError('invalid_value', `${field} no se puede representar en ASCII`);
  if (ascii.length > max) throw new EmvFormatError('too_long', `${field} pasa de ${max} caracteres`);
  return ascii;
}

/**
 * Arma el payload completo, con el CRC.
 *
 * @throws EmvFormatError si un campo no cumple los largos o el formato de EMV.
 */
export function buildMpmPayload(input: MpmInput): string {
  const dynamic = input.kind === 'dynamic';
  if (dynamic) {
    if (input.amountMinor === undefined || input.amountMinor <= 0n) throw new EmvFormatError('missing_field', 'El QR dinámico necesita un monto mayor que cero');
    if (!input.referenceLabel || !REFERENCE.test(input.referenceLabel)) throw new EmvFormatError('invalid_value', 'La referencia debe ser alfanumérica, de 1 a 25 caracteres');
  } else if (input.amountMinor !== undefined) {
    throw new EmvFormatError('invalid_value', 'El QR estático no lleva monto');
  }
  const mcc = input.mcc ?? MCC_UNKNOWN;
  if (!/^\d{4}$/.test(mcc)) throw new EmvFormatError('invalid_value', 'El MCC son 4 dígitos');

  const account = encodeTlv([
    { id: '00', value: toEmvText(input.accountGuid, 32, 'GUID') },
    { id: '01', value: toEmvText(input.merchantAccountRef, 60, 'Referencia del comercio') },
  ]);
  const fields: Tlv[] = [
    { id: '00', value: '01' },
    { id: '01', value: dynamic ? '12' : '11' },
    { id: '26', value: account },
    { id: '52', value: mcc },
    { id: '53', value: CURRENCY_BOB },
    ...(dynamic ? [{ id: '54', value: fromMinor(input.amountMinor as bigint) }] : []),
    { id: '58', value: COUNTRY_BO },
    { id: '59', value: toEmvText(input.merchantName, 25, 'Nombre del comercio') },
    { id: '60', value: toEmvText(input.merchantCity, 15, 'Ciudad') },
    { id: '62', value: encodeTlv([{ id: '05', value: dynamic ? (input.referenceLabel as string) : '***' }]) },
  ];
  const body = `${encodeTlv(fields)}6304`;
  return `${body}${crcHex(body)}`;
}

export interface ParsedMpm {
  /** Objetos de primer nivel, en el orden en que vienen (el CRC, el último). */
  readonly fields: readonly Tlv[];
  /** `true` si el CRC del payload coincide con el recalculado. */
  readonly crcValid: boolean;
  readonly pointOfInitiation: 'static' | 'dynamic' | 'unknown';
  readonly currencyNumeric: string | null;
  /** Monto tal como vino (`"100.00"`), o `null` si no trae. */
  readonly amount: string | null;
  readonly country: string | null;
  readonly merchantName: string | null;
  readonly merchantCity: string | null;
  readonly mcc: string | null;
  /** Plantillas de cuenta (26 a 51) con sus subobjetos. */
  readonly merchantAccounts: ReadonlyArray<{ readonly tag: string; readonly subfields: readonly Tlv[] }>;
  /** Etiqueta 62/05 si existe. */
  readonly referenceLabel: string | null;
}

/**
 * Lee un payload. Un CRC que no coincide NO lanza: se informa en `crcValid` para que quien llama decida.
 *
 * @throws EmvFormatError si la estructura TLV está rota, falta el CRC al final o el formato no es EMV MPM.
 */
export function parseMpmPayload(payload: string): ParsedMpm {
  if (typeof payload !== 'string' || payload.length < 12 || payload.length > 512) throw new EmvFormatError('invalid_length', 'Largo de payload fuera de rango');
  const fields = decodeTlv(payload);
  const last = fields[fields.length - 1];
  if (!last || last.id !== '63' || last.value.length !== 4) throw new EmvFormatError('missing_field', 'El payload debe terminar con el CRC (63)');
  const get = (id: string): string | null => fields.find((f) => f.id === id)?.value ?? null;
  if (fields[0].id !== '00' || fields[0].value !== '01') throw new EmvFormatError('invalid_value', 'No es un payload EMV MPM (00 debe ser 01)');

  const initiation = get('01');
  const body = payload.slice(0, -4);
  const additional = get('62');
  return {
    fields,
    crcValid: /^[0-9A-F]{4}$/.test(last.value) && crcHex(body) === last.value,
    pointOfInitiation: initiation === '11' ? 'static' : initiation === '12' ? 'dynamic' : 'unknown',
    currencyNumeric: get('53'),
    amount: get('54'),
    country: get('58'),
    merchantName: get('59'),
    merchantCity: get('60'),
    mcc: get('52'),
    merchantAccounts: fields.filter((f) => Number(f.id) >= 26 && Number(f.id) <= 51).map((f) => ({ tag: f.id, subfields: decodeTlv(f.value) })),
    referenceLabel: additional ? (decodeTlv(additional).find((f) => f.id === '05')?.value ?? null) : null,
  };
}
