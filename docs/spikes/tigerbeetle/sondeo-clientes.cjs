const { createClient } = require('tigerbeetle-node');
const ADDR = process.env.TB_ADDR; const N = +process.argv[2]; const MODE = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const t0 = Date.now(); const clients = [];
  const one = async (i) => {
    const c = createClient({ cluster_id: 0n, replica_addresses: [ADDR] }); clients.push(c);
    const t = Date.now();
    const r = await Promise.race([c.lookupAccounts([1n]).then(() => 'ok'), sleep(20000).then(() => 'TIMEOUT 20s')]);
    return { i, r, ms: Date.now() - t };
  };
  let out;
  if (MODE === 'seq') { out = []; for (let i = 0; i < N; i++) out.push(await one(i)); }
  else out = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
  console.log(MODE, 'N=' + N, 'ok=' + out.filter((x) => x.r === 'ok').length, 'timeout=' + out.filter((x) => x.r !== 'ok').length, 'total_ms=' + (Date.now() - t0), 'ms_por_cliente=' + out.map((x) => x.ms).join(','));
  await sleep(+(process.argv[4]||0)*1000); clients.forEach((c) => c.destroy()); process.exit(0);
})();
