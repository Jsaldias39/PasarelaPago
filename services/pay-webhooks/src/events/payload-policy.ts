import { PUBLIC_EVENT_TYPES } from './public-events';

/**
 * P1.H3.M5 — política de payload: SOLO ids, estados, códigos, fechas e importes en unidades menores.
 *
 * Es una LISTA DE PERMITIDOS por nombre de campo (lo desconocido se descarta, no se pasa) más una revisión del VALOR de
 * cada cadena (un correo, un teléfono o un número de tarjeta en cualquier campo permitido hace que el evento entero se
 * rechace: es un defecto del publicador, no algo que se arregle quitando un campo). Nunca se registra el valor ofensor.
 */
const ALLOWED_KEY = new RegExp(
  '^(' +
    [
      'id',
      '[a-z][a-z0-9_]*_ids?',
      '[a-z][a-z0-9_]*_minor',
      '[a-z][a-z0-9_]*_(at|from|to|date)',
      'currency',
      'status',
      'reason',
      'mode',
      'kind',
      'connector',
      'period',
      'frequency',
      'day_of_month',
      'attempt',
      'version',
      'failure_code',
      'payment_method_type',
      'next_action_type',
      '[a-z][a-z0-9_]*_(count|type|status|code)',
    ].join('|') +
    ')$',
);

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:^|\D)(?:\+?\d[\s-]?){8,15}(?:\D|$)/;
const LONG_DIGITS = /\d{13,19}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

export type PolicyViolationReason = 'email_in_value' | 'phone_in_value' | 'card_number_in_value' | 'not_scalar' | 'invalid_event';

export class PayloadPolicyError extends Error {
  constructor(
    readonly reason: PolicyViolationReason,
    /** Nombre del campo (no el valor). */
    readonly field: string,
  ) {
    super(`Evento rechazado por la política de payload: ${reason} en ${field}`);
    this.name = 'PayloadPolicyError';
  }
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Identificador de la pasarela (`pi_c92215200m49`, `we_…`, un UUID): lleva dígitos, pero no es un teléfono. */
const ID_SHAPED = /^(?:[a-z]{1,12}_[a-z0-9]{6,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function inspectString(value: string, field: string): void {
  if (EMAIL.test(value)) throw new PayloadPolicyError('email_in_value', field);
  const compact = value.replace(/[\s-]/g, '');
  const idShaped = ID_SHAPED.test(value);
  // En un id solo preocupa que el sufijo sea un número de tarjeta; en cualquier otra cadena, una corrida de dígitos con Luhn.
  const digitRun = idShaped ? /^[a-z]{1,12}_(\d{13,19})$/.exec(value)?.[1] : LONG_DIGITS.exec(compact)?.[0];
  if (digitRun && luhn(digitRun)) throw new PayloadPolicyError('card_number_in_value', field);
  // Las fechas ISO tienen muchos dígitos y no son teléfonos.
  if (!idShaped && !ISO_DATE.test(value) && PHONE.test(value)) throw new PayloadPolicyError('phone_in_value', field);
}

export interface FilteredData {
  readonly data: Record<string, string | number | boolean | null>;
  /** Campos descartados por no estar en la lista (solo nombres). */
  readonly dropped: readonly string[];
}

/** Filtra `data` de un evento. @throws PayloadPolicyError si un valor permitido trae datos personales o un campo no es escalar. */
export function filterEventData(data: Record<string, unknown>): FilteredData {
  const kept: Record<string, string | number | boolean | null> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_KEY.test(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof value === 'string') inspectString(value, key);
    else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') throw new PayloadPolicyError('not_scalar', key);
    kept[key] = value;
  }
  return { data: kept, dropped };
}

export interface PublicEnvelope {
  readonly id: string;
  readonly type: string;
  readonly time: string;
  readonly merchantId: string;
  readonly data: Record<string, unknown>;
}

/** Cuerpo público (lo que firma y recibe el comercio). Las claves salen en un orden fijo: el JSON es determinista. */
export function buildPublicPayload(event: PublicEnvelope, mode: 'test' | 'live'): { payload: string; dropped: readonly string[] } {
  if (!PUBLIC_EVENT_TYPES.includes(event.type)) throw new PayloadPolicyError('invalid_event', 'type');
  const { data, dropped } = filterEventData(event.data);
  const payload = JSON.stringify({ id: event.id, object: 'event', type: event.type, created_at: event.time, mode, data: { object: data } });
  return { payload, dropped };
}
