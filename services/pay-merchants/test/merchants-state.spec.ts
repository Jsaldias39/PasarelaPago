import { createTestContext, type TestContext } from './support/app';
import { acceptContract, activeMerchant, approveKyc, bo, createMerchant, ensureContractVersion, eventsOf, readyMerchant, uniqueKey, uploadAllDocs, verified } from './support/http';
import { merchantInput } from './support/fixtures';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

describe('alta de comercio (7.1)', () => {
  it('crea un comercio `pending`, lo devuelve según el contrato y publica merchant.created en el outbox', async () => {
    const res = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send(merchantInput(1));
    const body = verified(ctx.backofficeContract, 'post', '/merchants', res, 201);
    expect(body).toMatchObject({ object: 'merchant', status: 'pending', legal_type: 'srl', kyc: { status: 'pending' } });
    expect(body.kyc.missing_documents).toHaveLength(6);
    const events = await eventsOf(ctx, 'merchant.created', body.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: '/pay-merchants', merchantid: body.id, data: { status: 'pending' } });
  });

  it('es idempotente: la misma Idempotency-Key y el mismo cuerpo devuelven el mismo comercio y no duplican el evento', async () => {
    const key = uniqueKey();
    const first = await bo(ctx, 'post', '/merchants').set('idempotency-key', key).send(merchantInput(2));
    const second = await bo(ctx, 'post', '/merchants').set('idempotency-key', key).send(merchantInput(2));
    expect(verified(ctx.backofficeContract, 'post', '/merchants', first, 201).id).toBe(verified(ctx.backofficeContract, 'post', '/merchants', second, 200).id);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(await eventsOf(ctx, 'merchant.created', first.body.id)).toHaveLength(1);
    const other = await bo(ctx, 'post', '/merchants').set('idempotency-key', key).send(merchantInput(3));
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('idempotency_key_reused');
  });

  it('rechaza lo inválido con el campo y sin repetir el valor recibido: tipo societario fuera de la lista, campo extra, NIT repetido, sin Idempotency-Key', async () => {
    const send = (body: object, key: string | null = uniqueKey()) => {
      const req = bo(ctx, 'post', '/merchants');
      return (key ? req.set('idempotency-key', key) : req).send(body);
    };
    const badType = await send({ ...merchantInput(4), legal_type: 'ong' });
    expect(badType.status).toBe(422);
    expect(badType.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'legal_type' })]));
    expect(JSON.stringify(badType.body)).not.toContain('ong');
    expect((await send({ ...merchantInput(5), extra: 1 })).status).toBe(422);
    expect((await send(merchantInput(6), null)).body.code).toBe('idempotency_key_required');
    await send(merchantInput(7));
    const dup = await send({ ...merchantInput(8), tax_id: merchantInput(7).tax_id });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toEqual([{ field: 'tax_id', code: 'already_registered' }]);
  });
});

describe('activación (REQ-P5-1) — el kill-test del carril', () => {
  it('un comercio sin KYC aprobado Y sin contrato NO queda activo: 409 con los dos motivos y sin cambios ni evento', async () => {
    const id = await createMerchant(ctx, 10);
    const res = await bo(ctx, 'post', `/merchants/${id}/activate`);
    const body = verified(ctx.backofficeContract, 'post', `/merchants/${id}/activate`, res, 409);
    expect(body.code).toBe('invalid_state_transition');
    expect(body.errors).toEqual(expect.arrayContaining([{ field: 'kyc', code: 'not_approved' }, { field: 'contract', code: 'not_accepted' }]));
    const view = await bo(ctx, 'get', `/merchants/${id}`);
    expect(verified(ctx.backofficeContract, 'get', `/merchants/${id}`, view, 200).status).toBe('pending');
    expect(await eventsOf(ctx, 'merchant.activated', id)).toHaveLength(0);
  });

  it('con KYC aprobado pero sin contrato: 409 solo por el contrato; con contrato pero sin KYC: 409 solo por el KYC', async () => {
    await ensureContractVersion(ctx, 1);
    const onlyKyc = await createMerchant(ctx, 11);
    await uploadAllDocs(ctx, onlyKyc);
    await approveKyc(ctx, onlyKyc);
    const a = await bo(ctx, 'post', `/merchants/${onlyKyc}/activate`);
    expect(a.status).toBe(409);
    expect(a.body.errors).toEqual([{ field: 'contract', code: 'not_accepted' }]);

    const onlyContract = await createMerchant(ctx, 12);
    await acceptContract(ctx, onlyContract, 1);
    const b = await bo(ctx, 'post', `/merchants/${onlyContract}/activate`);
    expect(b.status).toBe(409);
    expect(b.body.errors).toEqual([{ field: 'kyc', code: 'not_approved' }]);
  });

  it('con KYC aprobado y contrato vigente aceptado queda `active` y publica merchant.activated', async () => {
    const id = await readyMerchant(ctx, 13);
    const res = await bo(ctx, 'post', `/merchants/${id}/activate`);
    const body = verified(ctx.backofficeContract, 'post', `/merchants/${id}/activate`, res, 200);
    expect(body).toMatchObject({ status: 'active', kyc: { status: 'approved', missing_documents: [] }, contract: { up_to_date: true } });
    expect(await eventsOf(ctx, 'merchant.activated', id)).toHaveLength(1);
  });

  it('aceptar una versión VIEJA no alcanza: si ya rige la versión 2, el comercio que solo aceptó la 1 no se activa', async () => {
    const id = await readyMerchant(ctx, 14); // acepta la v1
    await ensureContractVersion(ctx, 2);
    const res = await bo(ctx, 'post', `/merchants/${id}/activate`);
    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual([{ field: 'contract', code: 'not_accepted' }]);
    await acceptContract(ctx, id, 2);
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(200);
  });

  it('10 activaciones simultáneas: exactamente una tiene efecto y se publica UN solo evento', async () => {
    const id = await readyMerchant(ctx, 15);
    const results = await Promise.all(Array.from({ length: 10 }, () => bo(ctx, 'post', `/merchants/${id}/activate`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await eventsOf(ctx, 'merchant.activated', id)).toHaveLength(1);
  });
});

describe('ciclo de vida: pending → active → suspended → closed', () => {
  it('suspende solo un comercio activo, con motivo, y lo puede reactivar mientras sus condiciones sigan', async () => {
    const pending = await createMerchant(ctx, 20);
    expect((await bo(ctx, 'post', `/merchants/${pending}/suspend`).send({ reason: 'manual' })).status).toBe(409);

    const id = await activeMerchant(ctx, 21);
    const res = await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'risk_review' });
    expect(verified(ctx.backofficeContract, 'post', `/merchants/${id}/suspend`, res, 200)).toMatchObject({ status: 'suspended', suspension_reason: 'risk_review' });
    const [event] = await eventsOf(ctx, 'merchant.suspended', id);
    expect(event.data).toMatchObject({ status: 'suspended', reason: 'risk_review' });

    expect((await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' })).status).toBe(409); // ya suspendido
    expect((await bo(ctx, 'post', `/merchants/${id}/activate`)).status).toBe(200);
    expect(await eventsOf(ctx, 'merchant.activated', id)).toHaveLength(2);
  });

  it('un motivo de suspensión que no está en el contrato, o ninguno, se rechaza', async () => {
    const id = await activeMerchant(ctx, 22);
    expect((await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'porque_si' })).status).toBe(422);
    expect((await bo(ctx, 'post', `/merchants/${id}/suspend`).send({})).status).toBe(422);
  });

  it('el cierre es terminal: publica merchant.closed y después ninguna transición, subida ni tarifa es posible', async () => {
    const id = await activeMerchant(ctx, 23);
    const res = await bo(ctx, 'post', `/merchants/${id}/close`);
    expect(verified(ctx.backofficeContract, 'post', `/merchants/${id}/close`, res, 200).status).toBe('closed');
    expect(await eventsOf(ctx, 'merchant.closed', id)).toHaveLength(1);
    for (const path of ['activate', 'close']) expect((await bo(ctx, 'post', `/merchants/${id}/${path}`)).status).toBe(409);
    expect((await bo(ctx, 'post', `/merchants/${id}/suspend`).send({ reason: 'manual' })).status).toBe(409);
    // y su NIT queda libre para un alta nueva
    const again = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send({ ...merchantInput(24), tax_id: merchantInput(23).tax_id });
    expect(again.status).toBe(201);
  });

  it('un comercio que no existe, o con un id mal formado, es 404', async () => {
    expect((await bo(ctx, 'get', '/merchants/mc_noexisteabcdef')).status).toBe(404);
    expect((await bo(ctx, 'get', '/merchants/xyz')).status).toBe(404);
    expect((await bo(ctx, 'post', '/merchants/mc_noexisteabcdef/activate')).status).toBe(404);
  });
});
