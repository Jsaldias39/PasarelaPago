import { generateKeyPair, generateSecret, signedHeaders } from '@pay/webhook-signature';
import { WebhookReceiver } from '../src/receiver/webhook-receiver';

/** P1.H3.M3 — el receptor de prueba verifica la firma (sirve para E6 y de ejemplo para los comercios). */
const NOW = 1_800_000_000;
const BODY = '{"id":"evt_1","type":"payment_intent.succeeded"}';

describe('WebhookReceiver', () => {
  const secret = generateSecret();
  const signed = (overrides: Partial<{ id: string; timestamp: number; payload: string; secrets: string[] }> = {}) => {
    const input = { id: 'msg-0001', timestamp: NOW, payload: BODY, secrets: [secret], ...overrides };
    return { headers: signedHeaders(input), body: input.payload };
  };
  const make = (options: Partial<ConstructorParameters<typeof WebhookReceiver>[0]> = {}) => new WebhookReceiver({ secrets: [secret], now: () => NOW, ...options });

  describe('nivel CORRECTO', () => {
    it('acepta una firma v1 válida', () => {
      const receiver = make();
      const { headers, body } = signed();
      expect(receiver.process(headers, body)).toBe(200);
      expect(receiver.accepted).toEqual([{ webhookId: 'msg-0001', timestamp: NOW, body: BODY }]);
    });

    it('acepta una firma v1a con la clave pública y rechaza otra clave', () => {
      const pair = generateKeyPair();
      const headers = signedHeaders({ id: 'msg-0002', timestamp: NOW, payload: BODY, secretKeys: [pair.secretKey] });
      expect(make({ secrets: undefined, publicKeys: [pair.publicKey] }).process(headers, BODY)).toBe(200);
      expect(make({ secrets: undefined, publicKeys: [generateKeyPair().publicKey] }).process(headers, BODY)).toBe(400);
    });

    it('durante una rotación acepta el mensaje firmado con dos secretos si conoce cualquiera de los dos', () => {
      const next = generateSecret();
      const { headers, body } = signed({ secrets: [secret, next] });
      expect(make({ secrets: [next] }).process(headers, body)).toBe(200);
      expect(make({ secrets: [secret] }).process(headers, body)).toBe(200);
    });

    it('por HTTP real: lee el cuerpo crudo, verifica y responde 200', async () => {
      const receiver = make();
      const url = await receiver.listen();
      try {
        const { headers, body } = signed();
        const response = await fetch(`${url}/hook`, { method: 'POST', headers: headers as Record<string, string>, body });
        expect(response.status).toBe(200);
        expect(receiver.accepted).toHaveLength(1);
      } finally {
        await receiver.close();
      }
    });
  });

  describe('nivel INVÁLIDO — una firma alterada se rechaza', () => {
    const rejects = (mutate: (s: ReturnType<typeof signed>) => { headers: Record<string, string | undefined>; body: string }, reason: string) => {
      const receiver = make();
      const { headers, body } = mutate(signed());
      expect(receiver.process(headers, body)).toBe(400);
      expect(receiver.accepted).toHaveLength(0);
      expect(receiver.log[0].outcome).toBe(reason);
    };

    it('cuerpo cambiado en un solo byte', () => rejects((s) => ({ headers: s.headers, body: s.body.replace('evt_1', 'evt_2') }), 'no_matching_signature'));
    it('cuerpo reserializado (mismos datos, otros bytes)', () => rejects((s) => ({ headers: s.headers, body: JSON.stringify(JSON.parse(s.body), null, 1) }), 'no_matching_signature'));
    it('firma alterada', () => rejects((s) => ({ headers: { ...s.headers, 'webhook-signature': s.headers['webhook-signature'].replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, body: s.body }), 'no_matching_signature'));
    it('otro webhook-id con la firma de otro mensaje', () => rejects((s) => ({ headers: { ...s.headers, 'webhook-id': 'msg-9999' }, body: s.body }), 'no_matching_signature'));
    it('marca de tiempo cambiada', () => rejects((s) => ({ headers: { ...s.headers, 'webhook-timestamp': String(NOW + 1) }, body: s.body }), 'no_matching_signature'));
    it('firmado con otro secreto', () => rejects(() => signed({ secrets: [generateSecret()] }), 'no_matching_signature'));
    it('sin la cabecera de firma', () => rejects((s) => ({ headers: { 'webhook-id': s.headers['webhook-id'], 'webhook-timestamp': s.headers['webhook-timestamp'] }, body: s.body }), 'missing_headers'));
    it('sin ninguna cabecera', () => rejects((s) => ({ headers: {}, body: s.body }), 'missing_headers'));
    it('marca de tiempo vieja (reenvío de un mensaje capturado)', () => rejects(() => signed({ timestamp: NOW - 301 }), 'timestamp_outside_tolerance'));
    it('marca de tiempo del futuro', () => rejects(() => signed({ timestamp: NOW + 301 }), 'timestamp_outside_tolerance'));
    it('marca de tiempo no numérica', () => rejects((s) => ({ headers: { ...s.headers, 'webhook-timestamp': 'ayer' }, body: s.body }), 'invalid_timestamp'));
  });

  describe('nivel LÍMITE', () => {
    it('justo en el borde de la tolerancia (300 s) se acepta; un segundo más, no', () => {
      expect(make().process(...(Object.values(signed({ timestamp: NOW - 300 })) as [Record<string, string>, string]))).toBe(200);
      expect(make().process(...(Object.values(signed({ timestamp: NOW - 301 })) as [Record<string, string>, string]))).toBe(400);
    });

    it('el mismo webhook-id dos veces: ambas dan 200 (reintento del emisor) pero se acepta UNA sola', () => {
      const receiver = make();
      const { headers, body } = signed();
      expect(receiver.process(headers, body)).toBe(200);
      expect(receiver.process(headers, body)).toBe(200);
      expect(receiver.accepted).toHaveLength(1);
      expect(receiver.log.map((l) => l.outcome)).toEqual(['ok', 'duplicate']);
      expect(receiver.arrivals('msg-0001')).toBe(2);
    });

    it('un cuerpo de más de 1 MiB se corta con 413 antes de verificar', async () => {
      const receiver = make();
      const url = await receiver.listen();
      try {
        const response = await fetch(url, { method: 'POST', body: 'a'.repeat(1024 * 1024 + 1) });
        expect(response.status).toBe(413);
        expect(receiver.accepted).toHaveLength(0);
      } finally {
        await receiver.close();
      }
    });
  });
});
