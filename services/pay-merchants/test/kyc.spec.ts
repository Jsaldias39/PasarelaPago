import { createHash } from 'node:crypto';
import { createTestContext, type TestContext } from './support/app';
import { approveKyc, bo, createMerchant, uploadAllDocs, verified } from './support/http';
import { fakePdfExecutable, jpeg, KINDS, pdf, png } from './support/fixtures';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const upload = (id: string, kind: string, file: Buffer, filename: string, contentType: string, as = 'op-kyc') =>
  bo(ctx, 'post', `/merchants/${id}/kyc/documents`, as).field('kind', kind).attach('file', file, { filename, contentType });
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);

describe('KYC: documentos (REQ-P5-8, P5.H1.M3)', () => {
  it('guarda el archivo en el almacén de objetos y en la base solo su clave, hash y tipo real', async () => {
    const id = await createMerchant(ctx, 100);
    const file = pdf('contenido-unico-100');
    const res = await upload(id, 'nit', file, 'nit.pdf', 'application/pdf');
    const body = verified(ctx.backofficeContract, 'post', `/merchants/${id}/kyc/documents`, res, 201);
    expect(body).toMatchObject({ kind: 'nit', detected_type: 'application/pdf', size_bytes: file.length, sha256: createHash('sha256').update(file).digest('hex') });

    const row = (await ctx.db.pool.query('SELECT * FROM kyc_documents WHERE id = $1', [body.id])).rows[0];
    expect(Object.keys(row).sort()).toEqual(['detected_type', 'id', 'kind', 'merchant_id', 'object_key', 'sha256', 'size_bytes', 'uploaded_at', 'uploaded_by']); // sin columna de contenido
    expect(row.uploaded_by).toBe('operator_kyc_01'); // sale de la credencial
    expect((await ctx.store.get(row.object_key)).equals(file)).toBe(true);
    // el contenido tampoco aparece en ninguna tabla de la base
    expect(await count(`SELECT count(*)::int AS n FROM kyc_documents WHERE object_key LIKE '%contenido-unico-100%' OR sha256 LIKE '%contenido%'`)).toBe(0);
  });

  it('decide el tipo por los primeros bytes, no por el nombre ni el Content-Type: un PDF con nombre .exe se acepta como PDF; PNG y JPEG se aceptan', async () => {
    const id = await createMerchant(ctx, 101);
    expect(verified(ctx.backofficeContract, 'post', `/merchants/${id}/kyc/documents`, await upload(id, 'seprec', pdf(), 'seprec.exe', 'application/x-msdownload'), 201).detected_type).toBe('application/pdf');
    expect(verified(ctx.backofficeContract, 'post', `/merchants/${id}/kyc/documents`, await upload(id, 'licencia_funcionamiento', png(), 'a.pdf', 'application/pdf'), 201).detected_type).toBe('image/png');
    expect(verified(ctx.backofficeContract, 'post', `/merchants/${id}/kyc/documents`, await upload(id, 'certificado_sedes', jpeg(), 'b.pdf', 'application/pdf'), 201).detected_type).toBe('image/jpeg');
  });

  it('rechaza un ejecutable que se hace pasar por PDF (nombre y Content-Type de PDF) y no guarda NADA: ni fila ni objeto', async () => {
    const id = await createMerchant(ctx, 102);
    const res = await upload(id, 'constitucion', fakePdfExecutable(), 'constitucion.pdf', 'application/pdf');
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'file', code: 'unsupported_type' }]);
    ctx.backofficeContract.assertResponse({ method: 'post', path: `/merchants/${id}/kyc/documents`, status: 422, body: res.body });
    expect(await count('SELECT count(*)::int AS n FROM kyc_documents WHERE merchant_id = $1', [id])).toBe(0);
  });

  it('acota el tamaño (KYC_MAX_BYTES de prueba = 4096), rechaza vacío, tipo de documento desconocido y falta de archivo', async () => {
    const id = await createMerchant(ctx, 103);
    const atLimit = Buffer.concat([pdf(), Buffer.alloc(4096 - pdf().length)]);
    expect(atLimit.length).toBe(4096);
    expect((await upload(id, 'nit', atLimit, 'ok.pdf', 'application/pdf')).status).toBe(201);
    const tooBig = Buffer.concat([pdf(), Buffer.alloc(4097 - pdf().length)]);
    expect((await upload(id, 'nit', tooBig, 'big.pdf', 'application/pdf')).status).toBe(422);
    expect((await upload(id, 'nit', Buffer.alloc(0), 'vacio.pdf', 'application/pdf')).status).toBe(422);
    expect((await upload(id, 'pasaporte', pdf(), 'x.pdf', 'application/pdf')).body.errors).toEqual([{ field: 'kind', code: 'unknown_kind' }]);
    const noFile = await bo(ctx, 'post', `/merchants/${id}/kyc/documents`, 'op-kyc').field('kind', 'nit');
    expect(noFile.status).toBe(422);
    expect(await count('SELECT count(*)::int AS n FROM kyc_documents WHERE merchant_id = $1', [id])).toBe(1);
  });

  it('no acepta documentos de un comercio inexistente (404) ni cerrado (409)', async () => {
    expect((await upload('mc_noexisteabcdef', 'nit', pdf(), 'x.pdf', 'application/pdf')).status).toBe(404);
    const id = await createMerchant(ctx, 104);
    await bo(ctx, 'post', `/merchants/${id}/close`);
    expect((await upload(id, 'nit', pdf(), 'x.pdf', 'application/pdf')).status).toBe(409);
  });
});

describe('KYC: revisión y nivel de riesgo', () => {
  it('no se puede aprobar sin los 6 documentos ni sin nivel de riesgo: 409 con lo que falta, y el KYC no cambia', async () => {
    const id = await createMerchant(ctx, 110);
    await uploadAllDocs(ctx, id, ['seprec', 'certificado_sedes']);
    const res = await bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send({ decision: 'approved' });
    const body = verified(ctx.backofficeContract, 'put', `/merchants/${id}/kyc/review`, res, 409);
    expect(body.errors).toEqual(expect.arrayContaining([
      { field: 'documents.seprec', code: 'missing' },
      { field: 'documents.certificado_sedes', code: 'missing' },
      { field: 'risk_level', code: 'required_to_approve' },
    ]));
    const view = verified(ctx.backofficeContract, 'get', `/merchants/${id}`, await bo(ctx, 'get', `/merchants/${id}`), 200);
    expect(view.kyc).toEqual({ status: 'pending', risk_level: null, missing_documents: ['seprec', 'certificado_sedes'] });
  });

  it('con los 6 documentos y un nivel de riesgo, aprueba; `reviewed_by` es el `sub` de la credencial y el cuerpo no puede imponerlo', async () => {
    const id = await createMerchant(ctx, 111);
    await uploadAllDocs(ctx, id);
    const spoof = await bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send({ decision: 'approved', risk_level: 'medium', reviewed_by: 'alguien_mas' });
    expect(spoof.status).toBe(422); // additionalProperties: false
    await approveKyc(ctx, id, 'medium');
    const row = (await ctx.db.pool.query('SELECT status, risk_level, reviewed_by FROM merchant_kyc WHERE merchant_id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'approved', risk_level: 'medium', reviewed_by: 'operator_kyc_01' });
  });

  it('puede pasar a en revisión y a rechazado; el rechazo no exige documentos y queda registrado', async () => {
    const id = await createMerchant(ctx, 112);
    expect(verified(ctx.backofficeContract, 'put', `/merchants/${id}/kyc/review`, await bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send({ decision: 'in_review' }), 200).kyc.status).toBe('in_review');
    const rejected = await bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send({ decision: 'rejected', note: 'documentación incompleta' });
    expect(verified(ctx.backofficeContract, 'put', `/merchants/${id}/kyc/review`, rejected, 200).kyc.status).toBe('rejected');
  });

  it('rechaza decisiones o niveles de riesgo fuera de la lista y notas demasiado largas', async () => {
    const id = await createMerchant(ctx, 113);
    for (const body of [{ decision: 'maybe' }, { decision: 'approved', risk_level: 'extremo' }, { decision: 'in_review', note: 'x'.repeat(501) }, {}]) {
      expect((await bo(ctx, 'put', `/merchants/${id}/kyc/review`, 'op-kyc').send(body)).status).toBe(422);
    }
  });

  it('la lista de documentos requeridos son exactamente los 6 del alta legal', () => {
    expect([...KINDS]).toEqual(['constitucion', 'nit', 'seprec', 'licencia_funcionamiento', 'certificado_sedes', 'poder_representante']);
  });
});
