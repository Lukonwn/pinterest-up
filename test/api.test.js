import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../server/db.js';
import { migrate } from '../scripts/migrate.js';
import { buildApp } from '../server/index.js';
import bcrypt from 'bcryptjs';

process.env.POSTBACK_SECRET ||= 'pb-test';
let base, server;
const sfx = Date.now();
const call = async (method, path, { token, body, headers } = {}) => {
  const r = await fetch(base + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

test.before(async () => {
  await migrate(pool, () => {});
  server = buildApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

test('fluxo completo', async () => {
  // auth
  assert.equal((await call('GET', '/users/me')).status, 401);
  const email = `u${sfx}@t.com`;
  let r = await call('POST', '/auth/register', { body: { name: 'Ana', email, password: 'senha-forte-1' } });
  assert.equal(r.status, 201);
  const token = r.body.data.token;
  assert.equal((await call('POST', '/auth/register', { body: { name: 'Ana', email, password: 'senha-forte-1' } })).status, 409);
  assert.equal((await call('POST', '/auth/login', { body: { email, password: 'errada-123' } })).status, 401);
  r = await call('POST', '/auth/login', { body: { email, password: 'senha-forte-1' } });
  assert.equal(r.status, 200);
  r = await call('GET', '/users/me', { token });
  assert.equal(r.body.data.companyData.filled, false);
  const uid = r.body.data.id;

  // admin
  const aEmail = `a${sfx}@t.com`;
  await pool.query(`INSERT INTO users (name,email,password_hash,role) VALUES ('Adm',$1,$2,'admin')`, [aEmail, await bcrypt.hash('admin-pass-1', 4)]);
  const admin = (await call('POST', '/auth/login', { body: { email: aEmail, password: 'admin-pass-1' } })).body.data.token;
  assert.equal((await call('GET', '/swagger-control/users', { token })).status, 403);

  // catálogo
  r = await call('POST', '/swagger-control/products', { token: admin, body: { name: 'Curso X', price: 100, category: 'Cursos', commissionPercentage: 40, image: 'https://x/y.png' } });
  assert.equal(r.status, 201);
  const pid = r.body.data.id;
  assert.equal(r.body.data.affiliation.commission.price, 40);
  r = await call('POST', '/swagger-control/pins/bulk', { token: admin, body: { pins: [{ title: 'P1', image: 'https://x/1.jpg', category: 'Casa' }, { title: 'P2', image: 'https://x/2.jpg', category: 'Casa' }] } });
  assert.equal(r.body.data.created, 2);
  r = await call('GET', '/products?search=Curso&limit=10', { token });
  assert.ok(r.body.data.some(p => p.id === pid)); assert.ok(r.body.pagination.totalItems >= 1);
  assert.ok((await call('GET', '/products/categories', { token })).body.data.some(c => c.name === 'Cursos'));
  r = await call('POST', `/products/${pid}/affiliate`, { token });
  const code = r.body.data.product.affiliateCode;
  assert.ok(code);
  assert.equal((await call('POST', `/products/${pid}/affiliate`, { token })).body.data.product.affiliateCode, code); // idempotente
  assert.equal((await call('GET', '/products/my/affiliates', { token })).body.data.length, 1);

  // pins
  r = await call('GET', '/pins/random?limit=5&category=casa', { token });
  assert.ok(r.body.data.length >= 2);
  const pin = r.body.data[0].id;
  assert.equal((await call('POST', `/pins/${pin}/like`, { token })).body.data.isLiked, true);
  assert.equal((await call('GET', `/pins/${pin}`, { token })).body.data.isLiked, true);
  assert.equal((await call('POST', `/pins/${pin}/like`, { token })).body.data.isLiked, false);
  assert.equal((await call('POST', `/pins/${pin}/view`, { token })).status, 200);

  // saldo + anúncios
  r = await call('POST', '/ads', { token, body: { productId: pid, name: 'Ad', budget: { total: 50 } } });
  assert.equal(r.status, 400); assert.match(r.body.message, /insuficiente/i);
  r = await call('PATCH', `/swagger-control/users/${uid}/adjust-balance`, { token: admin, body: { amount: 100, reason: 'teste' } });
  assert.equal(r.body.data.balance, 100);
  r = await call('POST', '/ads', { token, body: { productId: pid, name: 'Ad', budget: { total: 60 }, creative: { type: 'standard' } } });
  assert.equal(r.status, 201); assert.equal(r.body.data.balanceAfter, 40);
  const adId = r.body.data.id;
  assert.equal((await call('GET', '/balance', { token })).body.data.balance, 40);
  assert.equal((await call('PATCH', `/ads/${adId}/status`, { token, body: { status: 'paused' } })).status, 200);
  assert.equal((await call('GET', '/ads', { token })).body.data[0].status, 'paused');
  assert.equal((await call('PATCH', `/ads/${adId}/status`, { token, body: { status: 'finished' } })).status, 200);
  assert.equal((await call('GET', '/balance', { token })).body.data.balance, 100); // devolveu o orçamento
  assert.equal((await call('PATCH', `/ads/${adId}/status`, { token, body: { status: 'active' } })).status, 409);

  // vendas reais via postback
  assert.equal((await call('POST', '/postbacks/sale', { body: { affiliateCode: code, externalId: 's1', amount: 100 } })).status, 401);
  const pb = { 'x-postback-secret': process.env.POSTBACK_SECRET };
  r = await call('POST', '/postbacks/sale', { headers: pb, body: { affiliateCode: code, externalId: `s${sfx}`, amount: 100 } });
  assert.equal(r.body.data.commission, 40);
  r = await call('POST', '/postbacks/sale', { headers: pb, body: { affiliateCode: code, externalId: `s${sfx}`, amount: 100 } });
  assert.equal(r.body.data.duplicate, true);
  r = await call('GET', '/wallet', { token });
  assert.equal(r.body.data.withdrawBalance, 40);
  assert.equal((await call('GET', '/sales/stats', { token })).body.data.totalSales, 1);
  assert.equal((await call('GET', '/stats/dashboard', { token })).body.data.overview.todaySales, 1);
  assert.equal((await call('GET', '/notifications', { token })).body.data.some(n => n.type === 'sale'), true);

  // saques (sem taxa)
  r = await call('POST', '/cashout/request', { token, body: { amount: 30, pixKey: '52998224725', pixKeyType: 'cpf' } });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'COMPANY_DATA_REQUIRED');
  r = await call('POST', '/auth/company-data', { token, body: { type: 'PF', companyName: 'Ana', document: '529.982.247-25', birthDate: '1990-01-01', email } });
  assert.equal(r.body.data.user.companyData.filled, true);
  assert.equal((await call('POST', '/cashout/request', { token, body: { amount: 5, pixKey: '52998224725', pixKeyType: 'cpf' } })).status, 400); // abaixo do mínimo
  assert.equal((await call('POST', '/cashout/request', { token, body: { amount: 30, pixKey: '123', pixKeyType: 'cpf' } })).status, 400);
  assert.equal((await call('POST', '/cashout/request', { token, body: { amount: 500, pixKey: '52998224725', pixKeyType: 'cpf' } })).body.error, 'INSUFFICIENT_FUNDS');
  r = await call('POST', '/cashout/request', { token, body: { amount: 30, pixKey: '52998224725', pixKeyType: 'cpf' } });
  assert.equal(r.status, 200);
  const w1 = r.body.data.withdrawal.id;
  r = await call('POST', '/cashout/request', { token, body: { amount: 20, pixKey: '52998224725', pixKeyType: 'cpf' } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'PENDING_WITHDRAWAL');
  r = await call('GET', '/wallet', { token });
  assert.deepEqual([r.body.data.withdrawBalance, r.body.data.blockedBalance], [10, 30]);
  assert.equal((await call('GET', '/cashout/active', { token })).body.data.withdrawal.id, w1);
  assert.equal((await call('GET', '/cashout/fee', { token })).body.data.amount, 0);
  assert.equal((await call('POST', '/cashout/tax/generate', { token, body: {} })).status, 410);
  assert.equal((await call('POST', '/cashout/verification/fee/generate', { token, body: {} })).status, 410);
  // admin recusa -> devolve
  assert.equal((await call('POST', `/swagger-control/withdrawals/${w1}/reject`, { token: admin, body: { reason: 'dados' } })).status, 200);
  r = await call('GET', '/wallet', { token });
  assert.deepEqual([r.body.data.withdrawBalance, r.body.data.blockedBalance], [40, 0]);
  assert.equal((await call('POST', `/swagger-control/withdrawals/${w1}/reject`, { token: admin, body: {} })).status, 409);
  // novo saque, cancela
  r = await call('POST', '/cashout/request', { token, body: { amount: 25, pixKey: 'ana@t.com', pixKeyType: 'email' } });
  const w2 = r.body.data.withdrawal.id;
  assert.equal((await call('POST', `/cashout/cancel/${w2}`, { token })).status, 200);
  // novo saque, admin aprova
  r = await call('POST', '/cashout/request', { token, body: { amount: 40, pixKey: 'ana@t.com', pixKeyType: 'email' } });
  const w3 = r.body.data.withdrawal.id;
  assert.equal((await call('POST', `/swagger-control/withdrawals/${w3}/approve`, { token: admin, body: {} })).status, 200);
  r = await call('GET', '/wallet', { token });
  assert.deepEqual([r.body.data.withdrawBalance, r.body.data.blockedBalance], [0, 0]);
  assert.equal((await call('GET', `/cashout/receipt/${w3}`, { token })).status, 200);
  r = await call('GET', '/wallet/transactions', { token });
  assert.ok(r.body.data.transactions.find(t => t.type === 'withdrawal' && t.status === 'completed' && t.metadata.withdrawalId === w3));
  // livro-razão fecha com o saldo
  const led = await pool.query(`SELECT wallet, sum(amount) s FROM transactions WHERE user_id=$1 GROUP BY wallet`, [uid]);
  const u = (await pool.query('SELECT balance, withdraw_balance FROM users WHERE id=$1', [uid])).rows[0];
  for (const row of led.rows) assert.equal(row.s, row.wallet === 'balance' ? u.balance : u.withdraw_balance);

  // cartão nunca é coletado
  assert.equal((await call('POST', '/balance/check', { token, body: { cardNumber: '4111' } })).status, 410);

  // suporte
  r = await call('POST', '/support/tickets', { token, body: { subject: 'Ajuda', message: 'Olá', category: 'conta' } });
  const tid = r.body.data.ticket.id;
  assert.equal((await call('POST', `/swagger-control/support/tickets/${tid}/reply`, { token: admin, body: { message: 'Oi, Ana' } })).status, 200);
  r = await call('GET', `/support/tickets/${tid}`, { token });
  assert.deepEqual(r.body.data.ticket.messages.map(m => m.sender), ['user', 'admin']);
  assert.equal((await call('POST', '/support/chat', { token, body: { message: 'chat' } })).status, 200);
  assert.equal((await call('GET', '/support/history', { token })).body.data.messages.length, 1);
  assert.equal((await call('PUT', '/notifications/read-all', { token })).status, 200);
  assert.equal((await call('GET', '/notifications', { token })).body.unreadCount, 0);

  // admin: bloqueio invalida sessão
  assert.equal((await call('PATCH', `/swagger-control/users/${uid}/toggle-status`, { token: admin })).body.data.status, 'blocked');
  assert.equal((await call('GET', '/users/me', { token })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { email, password: 'senha-forte-1' } })).status, 403);
  r = await call('GET', '/swagger-control/dashboard', { token: admin });
  assert.ok(r.body.data.totalUsers >= 2);
});
