const express = require('/home/user/mantra-core-health-api/node_modules/express');
const http = require('http');
const isPath = (url) => (url ?? '').split('?')[0].replace(/\/+$/u, '').toLowerCase() === '/payments/gateway-webhooks';
const app = express();
app.use(express.json({ limit: '1mb', verify: (req, _r, buf) => { if (isPath(req.url)) req.rawBody = buf; } }));
app.use((_q, r) => r.status(404).end());
const srv = app.listen(0, async () => {
  const port = srv.address().port;
  const hit = (path) => new Promise((res) => { const t = Date.now(); const rq = http.request({ port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': 2 } }, (r) => { r.resume(); r.on('end', () => res(Date.now() - t)); }); rq.on('error', () => res(-1)); rq.end('{}'); });
  console.log('normal ms', await hit('/x'));
  for (const n of [4000, 8000, 15000]) console.log('slashes', n, 'ms', await hit('/' + '/'.repeat(n) + 'x'));
  srv.close();
});
