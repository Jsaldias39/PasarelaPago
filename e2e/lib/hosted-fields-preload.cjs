'use strict';
/**
 * [DOBLE DECLARADO] «Campos alojados del PSP» para el stack E2E. NO es código del producto ni del servicio: se carga con `NODE_OPTIONS=--require` SOLO en el proceso de
 * `pay-vault` de la prueba E7, antes de que arranque la aplicación.
 *
 * Por qué existe: en producción el pagador teclea la tarjeta en el formulario alojado del PSP (D-17) y el PAN viaja de su navegador a la bóveda sin pasar por la pasarela. El único
 * backend que hoy tiene `pay-vault` es `FakeVaultBackend` (un doble en memoria), y su método `completeCapture` —lo que haría ese formulario— existe solo dentro del proceso: no hay
 * ninguna ruta HTTP por la que un pagador pueda entregar la tarjeta. Este archivo abre un puerto local que hace de ese formulario: `POST /hosted/<cs_…>` con la tarjeta en JSON llama
 * a `completeCapture` de la MISMA instancia que usa el servicio. No registra nada, no devuelve el token (el token solo sale por `GET /capture_sessions/<id>` de la bóveda, como en el contrato)
 * y nunca debe usarse con `PAY_MODE=live` (el doble de la bóveda ya se niega a arrancar en live).
 *
 * Variables: `E2E_HOSTED_FIELDS_PORT` (puerto, obligatorio). El servidor escucha solo en 127.0.0.1.
 */
const http = require('node:http');
const path = require('node:path');

const port = Number(process.env.E2E_HOSTED_FIELDS_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('hosted-fields-preload: falta E2E_HOSTED_FIELDS_PORT');
if (process.env.PAY_MODE !== 'sandbox') throw new Error('hosted-fields-preload: solo con PAY_MODE=sandbox');

const { FakeVaultBackend } = require(path.join(process.cwd(), 'dist', 'backend', 'fake-vault-backend.js'));
let backend;
const open = FakeVaultBackend.prototype.openCapture;
FakeVaultBackend.prototype.openCapture = function patched(input) {
  backend = this; // la instancia que usa el servicio
  return open.call(this, input);
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const match = /^\/hosted\/(cs_[a-z0-9]{10,40})$/.exec(req.url || '');
  if (req.method !== 'POST' || !match) return send(res, 404, { error: 'not_found' });
  if (!backend) return send(res, 503, { error: 'no_capture_session_opened' });
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let card;
    try {
      card = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }
    try {
      backend.completeCapture(match[1], { number: String(card.number), expMonth: Number(card.exp_month), expYear: Number(card.exp_year), cvv: String(card.cvv), ...(card.holder_name ? { holderName: String(card.holder_name) } : {}) });
    } catch (error) {
      // El mensaje de `completeCapture` nunca trae el número (dice «número de tarjeta inválido», «sesión no abierta»…): se devuelve un código fijo.
      return send(res, 422, { error: error instanceof Error && /sesi/.test(error.message) ? 'session_not_open' : 'invalid_card' });
    }
    return send(res, 200, { completed: true });
  });
});
server.unref();
server.listen(port, '127.0.0.1');
