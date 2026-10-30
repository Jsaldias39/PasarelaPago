import { isGatewayWebhookPath } from './wt/src/modules/payments/gateway/payments-gateway-raw-body.ts';
const t=(u:string)=>{const s=process.hrtime.bigint();const r=isGatewayWebhookPath(u);return [r,Number(process.hrtime.bigint()-s)/1e6] as const};
const cases:Record<string,string>={
 'slashes100k+x':'/'+'/'.repeat(100000)+'x','slashes100k':'/'.repeat(100000),'legit+100k slashes':'/payments/gateway-webhooks'+'/'.repeat(100000),
 'query 100k slashes':'/'.repeat(100000)+'?a=b','1M slashes':'/'.repeat(1000000)+'x','query long 1M':'/payments/gateway-webhooks?'+'/'.repeat(1000000),
 'legit':'/payments/gateway-webhooks','trailing':'/payments/gateway-webhooks/','upper':'/PAYMENTS/Gateway-Webhooks/','upper+query':'/Payments/Gateway-Webhooks/?x=1',
 'double slash in mid':'/payments//gateway-webhooks','abs-form':'http://h/payments/gateway-webhooks','encoded':'/payments/gateway%2Dwebhooks','semicolon':'/payments/gateway-webhooks;x=1','hash':'/payments/gateway-webhooks#x'};
for(const [k,u] of Object.entries(cases)){t(u);const best=Math.min(t(u)[1],t(u)[1],t(u)[1]);console.log(k.padEnd(22),t(u)[0],best.toFixed(3)+'ms');}
