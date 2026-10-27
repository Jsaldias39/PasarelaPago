/** Archivos SINTÉTICOS para las pruebas de KYC. Ningún documento real. */
export const pdf = (extra = ''): Buffer => Buffer.from(`%PDF-1.7\n% documento sintético de prueba ${extra}\n%%EOF\n`);
export const png = (): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('sintetico')]);
export const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('sintetico')]);
/** Un ejecutable de Windows («MZ») que se hace pasar por PDF por su nombre y su Content-Type. */
export const fakePdfExecutable = (): Buffer => Buffer.from('MZ\x90\x00\x03\x00\x00\x00 no soy un pdf');

export const KINDS = ['constitucion', 'nit', 'seprec', 'licencia_funcionamiento', 'certificado_sedes', 'poder_representante'] as const;
/** Datos de comercio ficticios y declarados como tales. */
export const merchantInput = (n: number) => ({
  display_name: `Comercio Sintético ${n}`,
  legal_name: `Razón Social Sintética ${n} S.R.L.`,
  legal_type: 'srl',
  tax_id: `1000${String(n).padStart(6, '0')}`,
});
export const SHA = 'a'.repeat(64);
