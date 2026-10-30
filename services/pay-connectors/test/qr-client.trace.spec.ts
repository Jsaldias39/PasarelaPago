import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { HttpQrClient } from '../src/connectors/qr-http.client';

/**
 * P1.H2.M3: pay-connectors reenvía a pay-qr el `traceparent` del contexto ACTIVO (el de la petición que le mandó pay-payments), no uno fabricado. [DOBLE] de pay-qr: un
 * servidor HTTP local. El SDK de OpenTelemetry es el real (contexto, propagador W3C); la instrumentación http, que abre el span servidor, se prueba contra Jaeger en
 * e2e/flows/traza-jaeger-arbol.e2e.ts.
 */
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
let server: Server;
let baseUrl: string;
const seen: IncomingMessage['headers'][] = [];
const input = { chargeId: 'ch_aaaaaaaaaaaaaaaa', paymentIntentId: 'pi_aaaaaaaaaaaaaaaa', merchantId: 'mc_aaaaaaaaaaaaaaaa', payMode: 'test' as const, amountMinor: 12345n, expiresAt: new Date('2026-10-27T13:00:00Z') };

beforeAll(async () => {
  new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(new tracing.InMemorySpanExporter())], autoDetectResources: false }).start();
  server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ payload: '000201...6304ABCD' })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
});

describe('HttpQrClient — traceparent hacia pay-qr', () => {
  it('correcto: dentro de un span activo reenvía su traceId y su spanId, y conserva el resto de las cabeceras de servicio', async () => {
    await trace.getTracer('t').startActiveSpan('petición de pay-payments', async (span) => {
      await new HttpQrClient(baseUrl).issue(input);
      span.end();
      expect(seen[0]!.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    });
    expect(seen[0]!['x-service-id']).toBe('pay-connectors');
    expect(seen[0]!['idempotency-key']).toBe('qr-ch_aaaaaaaaaaaaaaaa');
  });

  it('límite: contexto NO muestreado (flags 00) ⇒ viaja con flags 00 y la misma traza', async () => {
    const tid = hex(16);
    const parent = propagation.extract(ROOT_CONTEXT, { traceparent: `00-${tid}-${hex(8)}-00` });
    await context.with(parent, () => new HttpQrClient(baseUrl).issue(input));
    expect(seen[0]!.traceparent).toMatch(new RegExp(`^00-${tid}-[0-9a-f]{16}-00$`));
  });

  it('inválido: sin span activo NO se fabrica ningún traceparent y el QR se emite igual', async () => {
    const result = await context.with(ROOT_CONTEXT, () => new HttpQrClient(baseUrl).issue(input));
    expect(result.payload).toBe('000201...6304ABCD');
    expect(seen[0]!.traceparent).toBeUndefined();
    expect(seen[0]!.tracestate).toBeUndefined();
    expect(seen[0]!.baggage).toBeUndefined();
  });
});
