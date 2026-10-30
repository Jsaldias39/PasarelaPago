import QRCode from 'qrcode';

/**
 * Imagen del QR. Solo lleva el payload (que ya no trae datos personales: monto, referencia y el id del comercio).
 * Corrección de errores M y margen de 2 módulos: legible en pantallas y en impresión.
 */
export async function renderQr(payload: string, format: 'svg' | 'png'): Promise<Buffer> {
  const options = { errorCorrectionLevel: 'M', margin: 2 } as const;
  if (format === 'svg') return Buffer.from(await QRCode.toString(payload, { ...options, type: 'svg' }), 'utf8');
  return QRCode.toBuffer(payload, { ...options, type: 'png', scale: 8 });
}
