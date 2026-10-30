import subprocess, sys, shutil, os, re
MAIN='/home/user/pasarelapago/services'
W='/tmp/claude-0/-home-user/e2a1ca80-8ad4-54a7-8e83-0b9ce0655bff/scratchpad/fb-wt/services'
OUT='/home/user/pasarelapago/docs/trabajo/ola-5/P1/evidencia/fb-mutaciones.txt'
JEST='node --experimental-vm-modules ../../node_modules/jest-cli/bin/jest.js --config jest.config.cjs'
# (id, servicio, archivo, (viejo, nuevo), specs)
M=[
 ('F-B1.a el defecto vuelve a ser borrar','pay-webhooks','src/engine/svix/svix-reconciler.ts',("options.orphanAction ?? 'disable'","options.orphanAction ?? 'delete'"),['test/svix/svix-reconciler-orphan-action.spec.ts']),
 ('F-B1.b el reconciliador ignora la marca de liberado','pay-webhooks','src/engine/svix/svix-reconciler.ts',("svix.metadata[ORPHAN_REVIEW_KEY] === ORPHAN_REVIEW_RELEASED","false"),['test/svix/svix-reconciler-orphan-action.spec.ts']),
 ('F-B1.c no se relee la base antes de actuar','pay-webhooks','src/engine/svix/svix-reconciler.ts',("if ((still.rowCount ?? 0) > 0) continue;",""),['test/svix/svix-reconciler-orphan-action.spec.ts']),
 ('F-B1.d desaparece la confirmación deliberada en live','pay-webhooks','src/config.ts',("payMode === 'live' && env.WEBHOOKS_SVIX_ORPHAN_DELETE_ACK !== ORPHAN_DELETE_ACK","false"),['test/health.spec.ts']),
 ('F-B1.e sobre el tope en modo delete no se deshabilita (queda vivo)','pay-webhooks','src/engine/svix/svix-reconciler.ts',("      mode = 'disable';\n    }","      return;\n    }"),['test/svix/svix-reconciler-orphan-action.spec.ts']),
 ('F-B2.a (webhooks) vuelve max_deliver 20','pay-webhooks','src/events/consumer-redelivery.ts',("max_deliver: -1, ack_wait","max_deliver: 20, ack_wait"),['test/event-redelivery.spec.ts']),
 ('F-B2.b (webhooks) nak sin retardo (reentrega en caliente)','pay-webhooks','src/events/event-consumer.ts',("message.nak(redeliveryDelayMs(deliveries, this.redelivery));","message.nak();"),['test/event-redelivery.spec.ts']),
 ('F-B2.c (webhooks) no se migra un durable existente','pay-webhooks','src/events/consumer-redelivery.ts',("if (config.max_deliver === -1 && config.ack_wait === wanted.ack_wait && !config.backoff?.length) return 'unchanged';","return 'unchanged';"),['test/event-redelivery.spec.ts']),
 ('F-B2.d (payments) vuelve max_deliver 20','pay-payments','src/events/consumer-redelivery.ts',("max_deliver: -1, ack_wait","max_deliver: 20, ack_wait"),['test/events.redelivery.spec.ts']),
 ('F-B2.e (payments) nak sin retardo','pay-payments','src/events/nats-consumers.ts',("message.nak(redeliveryDelayMs(deliveries, this.redelivery));","message.nak();"),['test/events.redelivery.spec.ts']),
 ('F-B2.f (settlement) vuelve max_deliver 20','pay-settlement','src/consumer-redelivery.ts',("max_deliver: -1, ack_wait","max_deliver: 20, ack_wait"),['test/nats.spec.ts']),
 ('F-B2.g (settlement) nak sin retardo','pay-settlement','src/events.module.ts',("message.nak(redeliveryDelayMs(deliveries, this.redelivery));","message.nak();"),['test/nats.spec.ts']),
 ('F-B2.h (edge) vuelve max_deliver 20','pay-edge','src/replica/consumer-redelivery.ts',("max_deliver: -1, ack_wait","max_deliver: 20, ack_wait"),['test/replica-redelivery.spec.ts']),
 ('F-B2.i (edge) nak sin retardo','pay-edge','src/replica/replica.consumer.ts',("message.nak(redeliveryDelayMs(deliveries, this.redelivery));","message.nak();"),['test/replica-redelivery.spec.ts']),
 ('F-B2.j (schedules) vuelve max_deliver 20','pay-schedules','src/replica/consumer-redelivery.ts',("max_deliver: -1, ack_wait","max_deliver: 20, ack_wait"),['test/nats-redelivery.spec.ts']),
 ('F-B2.k (schedules) nak sin retardo','pay-schedules','src/replica/replica.consumer.ts',("message.nak(redeliveryDelayMs(deliveries, this.redelivery));","message.nak();"),['test/nats-redelivery.spec.ts']),
 ('F-D1.a el live ya no bloquea la readiness','pay-webhooks','src/append-only-guards.ts',("return this.payMode === 'live' && !report.ok;","return false;"),['test/append-only-guards.spec.ts']),
 ('F-D1.b un trigger deshabilitado cuenta como presente','pay-webhooks','src/append-only-guards.ts',("          AND t.tgenabled IN ('O', 'A')\n",""),['test/append-only-guards.spec.ts']),
 ('F-D1.c el chequeo ya no es fail-closed','pay-webhooks','src/append-only-guards.ts',("return { report: { ok: false, missing: expected.map((guard) => guard.name) }, verified: false };","return { report: { ok: true, missing: [] }, verified: false };"),['test/append-only-guards.spec.ts']),
 ('F-D1.d la readiness no expone checks','pay-webhooks','src/health.controller.ts',("return { ...result, checks };","return { ...result };"),['test/append-only-guards.spec.ts']),
 ('F-B3.a vuelve la regex de 5 caracteres','pay-webhooks','src/endpoints/endpoint.service.ts',("const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;","const SQLSTATE = /^[0-9A-Z]{5}$/;"),['test/definite-database-error.spec.ts']),
 ('F-B3.b se ignora la severidad (FATAL cuenta como definitivo)','pay-webhooks','src/endpoints/endpoint.service.ts',(" && severity === 'ERROR';",";"),['test/definite-database-error.spec.ts']),
]
only=sys.argv[1] if len(sys.argv)>1 else None
# sincroniza el worktree con el árbol principal (código nuevo)
for svc in ['pay-webhooks','pay-payments','pay-settlement','pay-edge','pay-schedules']:
    for sub in ['src','test']:
        subprocess.run(['cp','-a',f'{MAIN}/{svc}/{sub}/.',f'{W}/{svc}/{sub}/'],check=True)
lines=['# MUTACIONES: cada arreglo se rompe a propósito en un worktree aparte (nunca en el árbol principal) y su prueba dirigida tiene que ponerse ROJA; luego se restaura.','# Resultado: "ROJO" = la mutación fue detectada (bien); "VERDE" = sobrevivió (hueco en la prueba).','']
base={}
for (mid,svc,rel,(old,new),specs) in M:
    key=(svc,tuple(specs))
    if key in base: continue
    r=subprocess.run(f'flock /tmp/pay-heavy.lock {JEST} {" ".join(specs)} 2>&1',shell=True,cwd=f'{W}/{svc}',capture_output=True,text=True,timeout=None)
    m=re.search(r'^Tests:\s+(.*)$',r.stdout,re.M)
    base[key]=(r.returncode==0)
    lines.append(f'BASE [{svc}] {" ".join(specs)} sin mutar -> {"VERDE" if r.returncode==0 else "ROJO (la base no sirve)"} | {m.group(1) if m else ""}'); print(lines[-1]); sys.stdout.flush()
lines.append('')
for (mid,svc,rel,(old,new),specs) in M:
    if not base[(svc,tuple(specs))]:
        lines.append(f'{mid}: OMITIDA (la base sin mutar no está verde)'); continue
    f=f'{W}/{svc}/{rel}'
    orig=open(f).read()
    if old not in orig:
        lines.append(f'{mid}: NO APLICA (no se encontró el texto)'); print(lines[-1]); continue
    open(f,'w').write(orig.replace(old,new,1))
    try:
        r=subprocess.run(f'flock /tmp/pay-heavy.lock {JEST} {" ".join(specs)} 2>&1',shell=True,cwd=f'{W}/{svc}',capture_output=True,text=True,timeout=None)
        txt=r.stdout
        m=re.search(r'^Tests:\s+(.*)$',txt,re.M)
        summary=m.group(1) if m else 'sin resumen: '+txt[-300:]
        failed=re.findall(r'●.*›.*',txt)
        verdict='ROJO' if (r.returncode!=0) else 'VERDE'
        lines.append(f'{mid} [{svc}] -> {verdict} | {summary}')
        for t in sorted(set(failed))[:3]: lines.append('     '+t.strip()[:230])
    finally:
        open(f,'w').write(orig)
    print(lines[-1] if not failed else lines[-len(sorted(set(failed))[:3])-1]); sys.stdout.flush()
open(OUT,'w').write('\n'.join(lines)+'\n')
