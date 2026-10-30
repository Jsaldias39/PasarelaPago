/** Error de formato de un payload EMVCo. `code` es estable; el mensaje no incluye el payload (puede traer una referencia de pago). */
export class EmvFormatError extends Error {
  constructor(
    readonly code: 'invalid_tag' | 'invalid_length' | 'truncated' | 'empty_value' | 'too_long' | 'invalid_value' | 'missing_field',
    message: string,
  ) {
    super(message);
    this.name = 'EmvFormatError';
  }
}

/** Un objeto de datos EMVCo: etiqueta de 2 dígitos, longitud de 2 dígitos (1 a 99) y valor. */
export interface Tlv {
  readonly id: string;
  readonly value: string;
}

/**
 * Codifica una lista de objetos TLV.
 *
 * @throws EmvFormatError si una etiqueta no son 2 dígitos o un valor está vacío o pasa de 99 caracteres.
 */
export function encodeTlv(fields: readonly Tlv[]): string {
  return fields
    .map(({ id, value }) => {
      if (!/^\d{2}$/.test(id)) throw new EmvFormatError('invalid_tag', `Etiqueta inválida: ${id}`);
      if (value.length === 0) throw new EmvFormatError('empty_value', `La etiqueta ${id} no puede ir vacía`);
      if (value.length > 99) throw new EmvFormatError('too_long', `La etiqueta ${id} pasa de 99 caracteres`);
      return `${id}${String(value.length).padStart(2, '0')}${value}`;
    })
    .join('');
}

/**
 * Decodifica una cadena TLV de un solo nivel, de forma estricta: sin sobrantes, sin longitudes truncadas ni no numéricas.
 *
 * @throws EmvFormatError ante cualquier irregularidad.
 */
export function decodeTlv(text: string): Tlv[] {
  const out: Tlv[] = [];
  let i = 0;
  while (i < text.length) {
    const id = text.slice(i, i + 2);
    const rawLength = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id)) throw new EmvFormatError('invalid_tag', 'Etiqueta inválida');
    if (!/^\d{2}$/.test(rawLength)) throw new EmvFormatError(rawLength.length < 2 ? 'truncated' : 'invalid_length', `Longitud inválida en la etiqueta ${id}`);
    const length = Number(rawLength);
    if (length === 0) throw new EmvFormatError('empty_value', `La etiqueta ${id} viene vacía`);
    const value = text.slice(i + 4, i + 4 + length);
    if (value.length < length) throw new EmvFormatError('truncated', `La etiqueta ${id} está truncada`);
    out.push({ id, value });
    i += 4 + length;
  }
  return out;
}
