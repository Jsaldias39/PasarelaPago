import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { serviceHeaders } from '@pay/service-auth';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { BankService } from '../bank/bank.service';

interface Decoded {
  crc_valid?: unknown;
  amount?: unknown;
  currency_numeric?: unknown;
}

/** «6,5» no existe: el QR trae el monto como decimal con hasta dos cifras. A unidades menores SIN punto flotante. */
function toMinor(text: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return BigInt(match[1] as string) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

/**
 * Pagador simulado: hace lo que haría la app bancaria de quien paga. Decodifica el QR con `pay-qr` (CRC, moneda, monto), comprueba que el
 * banco lo conoce y que el monto coincide, y «paga». Nunca ve ni guarda datos de una persona real (sandbox).
 */
@Injectable()
export class PayerService {
  constructor(
    private readonly bank: BankService,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
  ) {}

  async pay(payload: string): Promise<{ chargeReference: string; status: string; amountMinor: bigint; alreadyPaid: boolean }> {
    const decoded = await this.decode(payload);
    if (decoded.crc_valid !== true) throw new ProblemError('validation_failed', { errors: [{ field: 'qr_payload', code: 'crc_invalid' }] });
    if (decoded.currency_numeric !== '068') throw new ProblemError('validation_failed', { errors: [{ field: 'qr_payload', code: 'currency_not_supported' }] });
    const qrAmount = typeof decoded.amount === 'string' ? toMinor(decoded.amount) : null;
    if (qrAmount === null) throw new ProblemError('validation_failed', { errors: [{ field: 'qr_payload', code: 'amount_missing' }] }); // un QR estático no se paga con este simulador
    const { row, view, alreadyPaid } = await this.bank.payByQr(payload);
    if (this.bank.amountOf(row) !== qrAmount) throw new ProblemError('validation_failed', { errors: [{ field: 'qr_payload', code: 'amount_mismatch' }] });
    return { chargeReference: row.reference, status: view.status, amountMinor: qrAmount, alreadyPaid };
  }

  private async decode(payload: string): Promise<Decoded> {
    if (!this.config.qrUrl) throw new ProblemError('internal_error', { detail: 'PAY_QR_URL no está configurado: el pagador no puede decodificar el QR' });
    let response: Response;
    try {
      response = await fetch(`${this.config.qrUrl.replace(/\/$/, '')}/qr/decode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...serviceHeaders('pay-mockbank', { 'x-pay-mode': 'test' }) },
        body: JSON.stringify({ payload }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ProblemError('connector_unavailable', { detail: 'pay-qr no responde' });
    }
    if (response.status === 422) throw new ProblemError('validation_failed', { errors: [{ field: 'qr_payload', code: 'not_an_emv_qr' }] });
    if (!response.ok) throw new ProblemError('connector_unavailable', { detail: 'pay-qr rechazó la decodificación' });
    return (await response.json()) as Decoded;
  }
}
