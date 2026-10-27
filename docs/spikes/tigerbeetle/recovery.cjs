// Lee el saldo de merchant:A:available de una corrida de spike.cjs (RUN=<hex>) para comparar antes y después de un kill -9.
const crypto = require('node:crypto');
const { createClient } = require('tigerbeetle-node');
const RUN = process.env.RUN; const ADDR = process.env.TB_ADDR;
const MAX128 = (1n << 128n) - 1n;
const id128 = (l) => { let v = BigInt('0x' + crypto.createHash('sha256').update(`alovida-pay|${RUN}|${l}`).digest().subarray(0, 16).toString('hex')); return v === 0n || v === MAX128 ? 1n : v; };
(async () => {
  const c = createClient({ cluster_id: 0n, replica_addresses: [ADDR] });
  const [a] = await c.lookupAccounts([id128('merchant:A:available')]);
  console.log(JSON.stringify({ debits_posted: String(a.debits_posted), credits_posted: String(a.credits_posted), debits_pending: String(a.debits_pending) }));
  c.destroy(); process.exit(0);
})();
