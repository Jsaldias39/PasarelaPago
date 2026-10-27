/**
 * CRC-16/CCITT-FALSE (polinomio 0x1021, valor inicial 0xFFFF, sin reflejo ni XOR final), el de EMV QRCPS para la etiqueta 63.
 *
 * Se calcula sobre TODO el payload hasta el final de `6304` inclusive (el encabezado de la etiqueta CRC entra en el cálculo)
 * y NO sobre los cuatro caracteres hexadecimales del CRC. Vector de comprobación estándar: `"123456789"` → `0x29B1`.
 * Verificado además contra 12 payloads publicados por terceros (ver `test/fixtures/published-vectors.json`).
 */
export function crc16CcittFalse(text: string): number {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** CRC en mayúsculas con cuatro dígitos hexadecimales, como va en el payload. */
export function crcHex(text: string): string {
  return crc16CcittFalse(text).toString(16).toUpperCase().padStart(4, '0');
}
