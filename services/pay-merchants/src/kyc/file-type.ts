export type DetectedType = 'application/pdf' | 'image/png' | 'image/jpeg';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Tipo REAL de un archivo por sus primeros bytes. No mira la extensión ni el `Content-Type` que declaró el cliente.
 * Es una comprobación de tipo, NO un análisis de malware: un PDF bien formado en la cabecera pero malicioso pasa.
 *
 * @returns El tipo, o `null` si no es PDF, PNG ni JPEG.
 */
export function detectType(bytes: Buffer): DetectedType | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}
