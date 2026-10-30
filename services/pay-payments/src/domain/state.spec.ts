import { ProblemError } from '@pay/problem';
import { assertTransition, canTransition, decideCallback, decideConnectorEvent, isTerminal, type IntentStatus } from './state';

// Spec reciclado de mantra-core-health-api `payment-callback-machine.spec.ts` (MCH-011): MISMAS aserciones; solo cambian los
// nombres de los conceptos (TXN_PROCESSING→pending, TXN_AUTHORIZED→authorized, TXN_CAPTURED→captured, TXN_FAILED→failed,
// TXN_VOIDED→canceled, TXN_SETTLED→settled).
describe('decideCallback (reciclado de payment-callback-machine, MCH-011)', () => {
  it('aplica el avance legítimo del ciclo de vida', () => {
    expect(decideCallback('pending', 'authorized')).toBe('aplicar');
    expect(decideCallback('pending', 'captured')).toBe('aplicar');
    expect(decideCallback('authorized', 'captured')).toBe('aplicar');
    expect(decideCallback('authorized', 'failed')).toBe('aplicar');
  });

  it('reconoce la reentrega del mismo hecho', () => {
    expect(decideCallback('captured', 'captured')).toBe('duplicado');
    expect(decideCallback('failed', 'failed')).toBe('duplicado');
  });

  it('trata como obsoleta la entrega atrasada de un hecho ya superado (REQ-P3-2)', () => {
    expect(decideCallback('captured', 'authorized')).toBe('obsoleto');
    expect(decideCallback('settled', 'captured')).toBe('obsoleto');
  });

  it('marca como contradicción el choque con una rama terminal (REQ-P3-3)', () => {
    expect(decideCallback('captured', 'failed')).toBe('contradiccion');
    expect(decideCallback('failed', 'captured')).toBe('contradiccion');
    expect(decideCallback('canceled', 'captured')).toBe('contradiccion');
  });
});

describe('decideCallback (cambios propios respecto del original)', () => {
  it('dos finales sin dinero que no coinciden no se concilian: obsoleto', () => {
    expect(decideCallback('canceled', 'expired')).toBe('obsoleto');
    expect(decideCallback('failed', 'canceled')).toBe('obsoleto');
    expect(decideCallback('expired', 'failed')).toBe('obsoleto');
  });

  it('un estado desconocido nunca se aplica en silencio', () => {
    expect(decideCallback('pending', 'inventado')).toBe('contradiccion');
    expect(decideCallback('inventado', 'captured')).toBe('contradiccion');
  });

  it('matriz completa: solo hay `aplicar` donde hay transición declarada y nunca desde un final', () => {
    const states = ['pending', 'authorized', 'captured', 'settled', 'failed', 'canceled', 'expired'];
    for (const from of states) {
      for (const to of states) {
        const d = decideCallback(from, to);
        if (['settled', 'failed', 'canceled', 'expired'].includes(from)) expect(d).not.toBe('aplicar');
        if (from === to) expect(d).toBe('duplicado');
      }
    }
  });
});

describe('decideConnectorEvent (REQ-P3-2 y REQ-P3-3 a nivel de intento)', () => {
  it('REQ-P3-2: succeeded + authorized atrasado ⇒ obsoleto, no retrocede', () => {
    expect(decideConnectorEvent({ intentStatus: 'succeeded', chargeStatus: 'captured', incoming: 'authorized' }).decision).toBe('obsoleto');
  });

  it('REQ-P3-3: succeeded + failed ⇒ contradicción', () => {
    expect(decideConnectorEvent({ intentStatus: 'succeeded', chargeStatus: 'captured', incoming: 'failed' }).decision).toBe('contradiccion');
  });

  it.each<IntentStatus>(['expired', 'canceled', 'failed'])('dinero capturado para un intento %s es contradicción aunque el cargo siga pending', (intentStatus) => {
    const d = decideConnectorEvent({ intentStatus, chargeStatus: 'pending', incoming: 'captured' });
    expect(d.decision).toBe('contradiccion');
    expect(d.reason).toContain('captured_for_');
  });

  it('el avance normal de un intento vivo se aplica', () => {
    expect(decideConnectorEvent({ intentStatus: 'requires_action', chargeStatus: 'pending', incoming: 'captured' }).decision).toBe('aplicar');
  });

  it('el mismo captured repetido sobre un intento ya succeeded es duplicado', () => {
    expect(decideConnectorEvent({ intentStatus: 'succeeded', chargeStatus: 'captured', incoming: 'captured' }).decision).toBe('duplicado');
  });
});

describe('ciclo de vida del intento', () => {
  it('los terminales no cambian nunca', () => {
    const terminals: IntentStatus[] = ['succeeded', 'failed', 'canceled', 'expired'];
    const all: IntentStatus[] = ['processing', 'requires_action', ...terminals];
    for (const t of terminals) {
      expect(isTerminal(t)).toBe(true);
      for (const to of all) expect(canTransition(t, to)).toBe(false);
    }
    expect(isTerminal('processing')).toBe(false);
  });

  it('el camino normal está permitido y un salto inválido da 409 invalid_state_transition', () => {
    expect(canTransition('processing', 'requires_action')).toBe(true);
    expect(canTransition('requires_action', 'processing')).toBe(true);
    expect(canTransition('processing', 'succeeded')).toBe(true);
    expect(() => assertTransition('succeeded', 'failed')).toThrow(ProblemError);
    try {
      assertTransition('expired', 'succeeded');
    } catch (error) {
      expect((error as ProblemError).code).toBe('invalid_state_transition');
      expect((error as ProblemError).status).toBe(409);
    }
  });
});
