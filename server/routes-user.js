import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { q, tx, move, HttpError } from './db.js';
import {
  ok, wrap, auth, signToken, publicUser, productOut, pinOut, page, pagination, num, notify, getSetting,
} from './util.js';

export const router = express.Router();

/* ---------- público ---------- */
router.get('/health', wrap(async (_req, res) => { await q('SELECT 1'); res.json({ ok: true }); }));
router.get('/config', wrap(async (_req, res) => ok(res, await getSetting('feature_flags'))));

// Rate limit simples em memória para login/registro
const hits = new Map();
const limit = (max, windowMs) => (req, _res, next) => {
  const k = `${req.path}:${req.ip}`, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return next(new HttpError(429, 'Muitas tentativas. Tente novamente em instantes.'));
  arr.push(now); hits.set(k, arr); next();
};
setInterval(() => hits.clear(), 3600e3).unref();

/* ---------- auth ---------- */
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
router.post('/auth/register', limit(20, 3600e3), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) throw new HttpError(400, 'Informe seu nome');
  if (!emailRe.test(email)) throw new HttpError(400, 'E-mail inválido');
  if (password.length < 8) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q(
    'INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *',
    [name, email, hash]);
  if (!rows[0]) throw new HttpError(409, 'Este e-mail já está cadastrado');
  await q(`INSERT INTO notifications (user_id,type,title,message) VALUES ($1,'info','Bem-vindo!','Sua conta foi criada com sucesso.')`, [rows[0].id]);
  res.status(201).json({ success: true, data: { user: publicUser(rows[0]), token: signToken(rows[0]) } });
}));

router.post('/auth/login', limit(30, 15 * 60e3), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await q('SELECT * FROM users WHERE lower(email)=$1', [email]);
  const u = rows[0];
  const valid = u && await bcrypt.compare(String(req.body.password || ''), u.password_hash);
  if (!valid) throw new HttpError(401, 'E-mail ou senha incorretos');
  if (u.status !== 'active') throw new HttpError(403, 'Conta bloqueada');
  ok(res, { user: publicUser(u), token: signToken(u) });
}));
router.post('/auth/login/2fa', (_req, _res, next) => next(new HttpError(501, 'Autenticação em dois fatores não habilitada')));
router.post('/auth/logout', (_req, res) => ok(res, null));

router.post('/auth/company-data', auth, wrap(async (req, res) => {
  const { type, companyName, document, birthDate, email } = req.body;
  if (!['PF', 'PJ'].includes(type)) throw new HttpError(400, 'Tipo inválido');
  const doc = String(document || '').replace(/\D/g, '');
  if (type === 'PF' && doc.length !== 11) throw new HttpError(400, 'CPF inválido');
  if (type === 'PJ' && doc.length !== 14) throw new HttpError(400, 'CNPJ inválido');
  if (!String(companyName || '').trim()) throw new HttpError(400, 'Nome é obrigatório');
  if (!emailRe.test(String(email || ''))) throw new HttpError(400, 'E-mail inválido');
  const data = { type, companyName: String(companyName).trim(), document: doc, birthDate: birthDate || null, email: String(email).trim() };
  const { rows } = await q('UPDATE users SET company_data=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.user.id, data]);
  ok(res, { user: publicUser(rows[0]) }, { message: 'Dados salvos' });
}));

/* ---------- usuário ---------- */
router.get('/users/me', auth, (req, res) => ok(res, publicUser(req.user)));
router.put('/users/me', auth, wrap(async (req, res) => {
  const sets = [], vals = [req.user.id];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (req.body.name !== undefined) {
    const n = String(req.body.name).trim(); if (n.length < 2) throw new HttpError(400, 'Nome inválido'); add('name', n);
  }
  if (typeof req.body.isInternational === 'boolean') add('is_international', req.body.isInternational);
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres');
    add('password_hash', await bcrypt.hash(String(req.body.password), 10));
  }
  if (!sets.length) return ok(res, publicUser(req.user));
  const { rows } = await q(`UPDATE users SET ${sets.join(',')}, updated_at=now() WHERE id=$1 RETURNING *`, vals);
  ok(res, publicUser(rows[0]), { message: 'Perfil atualizado' });
}));

/* ---------- produtos / afiliados ---------- */
router.get('/products/categories', auth, wrap(async (_req, res) => {
  const { rows } = await q('SELECT category AS name, count(*)::int AS count FROM products WHERE active GROUP BY 1 ORDER BY 2 DESC, 1');
  ok(res, rows);
}));

router.get('/products', auth, wrap(async (req, res) => {
  const pg = page(req);
  const w = ['active'], v = [];
  if (req.query.category) { v.push(req.query.category); w.push(`category = $${v.length}`); }
  if (req.query.search) { v.push(`%${String(req.query.search).trim()}%`); w.push(`(name ILIKE $${v.length} OR description ILIKE $${v.length})`); }
  const order = req.query.sortBy === 'price' ? 'price DESC' : req.query.sortBy === 'commission' ? 'price*commission_percentage DESC'
    : req.query.sortBy === 'hot' ? 'hot_score DESC, id DESC' : 'created_at DESC';
  const where = w.join(' AND ');
  const total = (await q(`SELECT count(*)::int c FROM products WHERE ${where}`, v)).rows[0].c;
  const { rows } = await q(`SELECT * FROM products WHERE ${where} ORDER BY ${order} LIMIT ${pg.limit} OFFSET ${pg.offset}`, v);
  ok(res, rows.map(p => productOut(p)), { pagination: pagination(total, pg) });
}));

router.get('/products/my/affiliates', auth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT p.*, a.code AS aff_code FROM affiliations a JOIN products p ON p.id=a.product_id
     WHERE a.user_id=$1 ORDER BY a.created_at DESC`, [req.user.id]);
  ok(res, rows.map(p => productOut(p, { affiliateCode: p.aff_code })));
}));

router.get('/products/:id(\\d+)', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM products WHERE id=$1 AND active', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Produto não encontrado');
  ok(res, productOut(rows[0]));
}));

router.post('/products/:id(\\d+)/affiliate', auth, wrap(async (req, res) => {
  const p = (await q('SELECT * FROM products WHERE id=$1 AND active', [req.params.id])).rows[0];
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  const code = crypto.randomBytes(5).toString('hex');
  const r = await q(
    `INSERT INTO affiliations (user_id,product_id,code) VALUES ($1,$2,$3)
     ON CONFLICT (user_id,product_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING code`,
    [req.user.id, p.id, code]);
  ok(res, { product: productOut(p, { affiliateCode: r.rows[0].code }) }, { message: 'Afiliação realizada' });
}));

/* ---------- pins ---------- */
router.get('/pins/categories', auth, wrap(async (_req, res) => {
  const { rows } = await q('SELECT category AS name, count(*)::int AS count FROM pins WHERE active GROUP BY 1 ORDER BY 2 DESC, 1');
  ok(res, rows);
}));

async function listPins(req, res, random) {
  const pg = page(req);
  const v = [req.user.id], w = ['p.active', '$1::bigint IS NOT NULL'];
  const cat = String(req.query.category || '').toLowerCase();
  if (cat && cat !== 'todos') { v.push(cat); w.push(`lower(p.category) = $${v.length}`); }
  if (req.query.search) { v.push(`%${req.query.search}%`); w.push(`(p.title ILIKE $${v.length} OR p.description ILIKE $${v.length})`); }
  const where = w.join(' AND ');
  const total = (await q(`SELECT count(*)::int c FROM pins p WHERE ${where}`, v)).rows[0].c;
  const { rows } = await q(
    `SELECT p.*, (l.user_id IS NOT NULL) AS liked FROM pins p
     LEFT JOIN pin_likes l ON l.pin_id=p.id AND l.user_id=$1
     WHERE ${where} ORDER BY ${random ? 'random()' : 'p.id DESC'} LIMIT ${pg.limit} OFFSET ${random ? 0 : pg.offset}`, v);
  ok(res, rows.map(r => pinOut(r, r.liked)), { pagination: pagination(total, pg) });
}
router.get('/pins/random', auth, wrap((req, res) => listPins(req, res, true)));
router.get('/pins', auth, wrap((req, res) => listPins(req, res, false)));
router.get('/pins/:id(\\d+)', auth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT p.*, EXISTS(SELECT 1 FROM pin_likes l WHERE l.pin_id=p.id AND l.user_id=$2) AS liked
     FROM pins p WHERE p.id=$1 AND p.active`, [req.params.id, req.user.id]);
  if (!rows[0]) throw new HttpError(404, 'Pin não encontrado');
  ok(res, pinOut(rows[0], rows[0].liked));
}));
router.post('/pins/:id(\\d+)/view', auth, wrap(async (req, res) => {
  await q('UPDATE pins SET views_count=views_count+1 WHERE id=$1', [req.params.id]); ok(res, null);
}));
router.post('/pins/:id(\\d+)/like', auth, wrap(async (req, res) => {
  const out = await tx(async c => {
    const del = await c.query('DELETE FROM pin_likes WHERE pin_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (del.rowCount) { await c.query('UPDATE pins SET likes_count=GREATEST(likes_count-1,0) WHERE id=$1', [req.params.id]); return false; }
    const ins = await c.query('INSERT INTO pin_likes (pin_id,user_id) SELECT id,$2 FROM pins WHERE id=$1', [req.params.id, req.user.id]);
    if (!ins.rowCount) throw new HttpError(404, 'Pin não encontrado');
    await c.query('UPDATE pins SET likes_count=likes_count+1 WHERE id=$1', [req.params.id]);
    return true;
  });
  ok(res, { isLiked: out });
}));

/* ---------- anúncios ---------- */
const adOut = a => {
  const remaining = Math.max(Math.round((a.budget_total - a.budget_spent) * 100) / 100, 0);
  return {
    id: a.id, _id: a.id, name: a.name, status: a.status, productId: a.product_id,
    product: a.p_name ? { id: a.product_id, _id: a.product_id, name: a.p_name, image: a.p_image, price: a.p_price, currency: a.p_currency } : undefined,
    budget: { total: a.budget_total, spent: a.budget_spent, remaining },
    creative: a.creative, strategy: a.strategy, targeting: a.targeting, automationRules: a.automation_rules,
    metrics: { impressions: a.impressions, clicks: a.clicks, conversions: a.conversions ?? 0, revenue: a.revenue ?? 0 },
    createdAt: a.created_at, finishedAt: a.finished_at,
  };
};
const AD_SELECT = `SELECT a.*, p.name p_name, p.image p_image, p.price p_price, p.currency p_currency,
  COALESCE((SELECT count(*) FROM sales s WHERE s.ad_id=a.id AND s.status='approved'),0)::int conversions,
  COALESCE((SELECT sum(amount) FROM sales s WHERE s.ad_id=a.id AND s.status='approved'),0) revenue
  FROM ads a JOIN products p ON p.id=a.product_id`;

router.post('/ads', auth, wrap(async (req, res) => {
  const b = req.body;
  const budget = num(b.budget?.total, 'Orçamento');
  const { minAdBudget } = await getSetting('limits', { minAdBudget: 10 });
  if (budget < minAdBudget) throw new HttpError(400, `Orçamento mínimo de ${minAdBudget.toFixed(2)}`);
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Defina um título para o anúncio');
  const out = await tx(async c => {
    const prod = (await c.query('SELECT id FROM products WHERE id=$1 AND active', [b.productId])).rows[0];
    if (!prod) throw new HttpError(404, 'Produto não encontrado');
    const ins = await c.query(
      `INSERT INTO ads (user_id,product_id,name,budget_total,creative,strategy,targeting,automation_rules)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.id, prod.id, name, budget, b.creative || {}, String(b.strategy || 'auto'), b.targeting || {}, JSON.stringify(b.automationRules || [])]);
    const after = await move(c, req.user.id, 'balance', -budget, 'ad_spend', `Orçamento do anúncio "${name}"`, { adId: ins.rows[0].id });
    return { id: ins.rows[0].id, after };
  });
  const ad = (await q(`${AD_SELECT} WHERE a.id=$1`, [out.id])).rows[0];
  res.status(201).json({ success: true, data: { ...adOut(ad), balanceAfter: out.after } });
}));
router.get('/ads', auth, wrap(async (req, res) => {
  const { rows } = await q(`${AD_SELECT} WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 200`, [req.user.id]);
  ok(res, rows.map(adOut));
}));
router.get('/ads/:id(\\d+)', auth, wrap(async (req, res) => {
  const a = (await q(`${AD_SELECT} WHERE a.id=$1 AND a.user_id=$2`, [req.params.id, req.user.id])).rows[0];
  if (!a) throw new HttpError(404, 'Anúncio não encontrado');
  ok(res, adOut(a));
}));
// "finished" encerra a campanha e devolve o orçamento não utilizado ao saldo.
router.patch('/ads/:id(\\d+)/status', auth, wrap(async (req, res) => {
  const status = req.body.status;
  if (!['active', 'paused', 'finished'].includes(status)) throw new HttpError(400, 'Status inválido');
  await tx(async c => {
    const a = (await c.query('SELECT * FROM ads WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id])).rows[0];
    if (!a) throw new HttpError(404, 'Anúncio não encontrado');
    if (a.status === 'finished') throw new HttpError(409, 'Anúncio já encerrado');
    if (status === 'finished') {
      const refund = Math.round((a.budget_total - a.budget_spent) * 100) / 100;
      if (refund > 0) await move(c, req.user.id, 'balance', refund, 'ad_refund', `Orçamento não utilizado de "${a.name}"`, { adId: a.id });
      await c.query(`UPDATE ads SET status='finished', finished_at=now() WHERE id=$1`, [a.id]);
    } else await c.query('UPDATE ads SET status=$2 WHERE id=$1', [a.id, status]);
  });
  ok(res, { status });
}));
router.get('/automations/:code', auth, (_req, res) => res.status(404).json({ success: false, message: 'Código inválido ou não encontrado.' }));

/* ---------- saldo / carteira ---------- */
const txOut = t => ({
  id: t.id, _id: t.id, type: t.type, amount: t.amount, balanceAfter: t.balance_after, status: t.status,
  description: t.description, metadata: t.metadata, createdAt: t.created_at,
});
router.get('/balance', auth, (req, res) => ok(res, { balance: req.user.balance }));
router.get('/balance/transactions', auth, wrap(async (req, res) => {
  const pg = page(req);
  const { rows } = await q(`SELECT * FROM transactions WHERE user_id=$1 AND wallet='balance' ORDER BY id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, [req.user.id]);
  ok(res, { transactions: rows.map(txOut) });
}));
// Recarga com cartão NUNCA coleta dados de cartão neste backend.
router.post('/balance/check', auth, (_req, res) => res.status(410).json({
  success: false, message: 'Recarga por cartão indisponível. Dados de cartão não são coletados por esta plataforma.' }));

router.get('/wallet', auth, wrap(async (req, res) => {
  const u = req.user;
  const agg = (await q(
    `SELECT COALESCE((SELECT sum(amount) FROM sales WHERE user_id=$1 AND status='approved'),0) rev,
            COALESCE((SELECT sum(budget_spent) FROM ads WHERE user_id=$1),0) spent`, [u.id])).rows[0];
  ok(res, {
    balance: u.balance, withdrawBalance: u.withdraw_balance, blockedBalance: u.blocked_balance,
    hasRecharged: u.has_recharged, totalRevenue: agg.rev, totalSpent: agg.spent, totalProfit: agg.rev - agg.spent,
  });
}));
router.get('/wallet/transactions', auth, wrap(async (req, res) => {
  const pg = page(req);
  const { rows } = await q(`SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, [req.user.id]);
  ok(res, { transactions: rows.map(txOut) });
}));

/* ---------- saques (sem qualquer cobrança antecipada) ---------- */
const wdOut = w => ({
  id: w.id, _id: w.id, amount: w.amount, requestedAmount: w.amount, pixKey: w.pix_key, pixKeyType: w.pix_key_type,
  status: w.status, note: w.admin_note, createdAt: w.created_at, processedAt: w.processed_at,
});
const PIX_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'random'];
export function validatePix(type, key) {
  const d = String(key || '').replace(/\D/g, '');
  if (type === 'cpf') return d.length === 11 && d;
  if (type === 'cnpj') return d.length === 14 && d;
  if (type === 'phone') return d.length >= 10 && d.length <= 11 && d;
  if (type === 'email') return emailRe.test(String(key).trim()) && String(key).trim().toLowerCase();
  if (type === 'random') return /^[0-9a-f-]{32,36}$/i.test(String(key).trim()) && String(key).trim();
  return false;
}

router.post('/cashout/request', auth, wrap(async (req, res) => {
  const amount = num(req.body.amount, 'Valor');
  const type = String(req.body.pixKeyType || '');
  if (!PIX_TYPES.includes(type)) throw new HttpError(400, 'Tipo de chave PIX inválido');
  const key = validatePix(type, req.body.pixKey);
  if (!key) throw new HttpError(400, 'Chave PIX inválida');
  const lim = await getSetting('limits', {});
  const min = req.user.is_international ? lim.minWithdrawUSD ?? 5 : lim.minWithdrawBRL ?? 20;
  if (amount < min) throw new HttpError(400, `O valor mínimo para saque é ${min.toFixed(2)}`);
  if (!req.user.company_data) throw new HttpError(400, 'Complete seus dados cadastrais antes de sacar', 'COMPANY_DATA_REQUIRED');
  const w = await tx(async c => {
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const pending = await c.query(`SELECT 1 FROM withdrawals WHERE user_id=$1 AND status='pending'`, [req.user.id]);
    if (pending.rowCount) throw new HttpError(409, 'Você tem um saque pendente. Aguarde a aprovação para realizar outro.', 'PENDING_WITHDRAWAL');
    const wd = (await c.query(
      'INSERT INTO withdrawals (user_id,amount,pix_key,pix_key_type) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, amount, key, type])).rows[0];
    await move(c, req.user.id, 'withdraw', -amount, 'withdrawal', 'Saque via PIX', { withdrawalId: wd.id }, true);
    await c.query(`UPDATE transactions SET status='pending' WHERE user_id=$1 AND type='withdrawal' AND (metadata->>'withdrawalId')::bigint=$2`, [req.user.id, wd.id]);
    await move(c, req.user.id, 'blocked', amount, 'withdrawal', null, {}, false);
    await notify(c, req.user.id, 'info', 'Saque solicitado', `Seu saque de ${amount.toFixed(2)} está em análise.`);
    return wd;
  });
  ok(res, { withdrawal: wdOut(w) }, { message: 'Saque solicitado' });
}));
router.get('/cashout/active', auth, wrap(async (req, res) => {
  const { rows } = await q(`SELECT * FROM withdrawals WHERE user_id=$1 AND status='pending' LIMIT 1`, [req.user.id]);
  ok(res, { withdrawal: rows[0] ? wdOut(rows[0]) : null });
}));
router.get('/cashout/my-withdrawals', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 200', [req.user.id]);
  ok(res, { withdrawals: rows.map(wdOut) });
}));
router.get('/cashout/status/:id(\\d+)', auth, wrap(async (req, res) => {
  const w = (await q('SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!w) throw new HttpError(404, 'Saque não encontrado');
  ok(res, { withdrawal: wdOut(w), ...wdOut(w) });
}));
router.get('/cashout/receipt/:id(\\d+)', auth, wrap(async (req, res) => {
  const w = (await q(`SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2 AND status='completed'`, [req.params.id, req.user.id])).rows[0];
  if (!w) throw new HttpError(404, 'Comprovante indisponível');
  ok(res, { ...wdOut(w), holder: req.user.company_data?.companyName ?? req.user.name });
}));
router.get('/cashout/fee', auth, (_req, res) => ok(res, { amount: 0, currency: 'BRL', description: 'Não há cobrança para sacar.' }));
router.post('/cashout/cancel/:id(\\d+)', auth, wrap(async (req, res) => {
  await tx(async c => {
    const w = (await c.query(`SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2 FOR UPDATE`, [req.params.id, req.user.id])).rows[0];
    if (!w) throw new HttpError(404, 'Saque não encontrado');
    if (w.status !== 'pending') throw new HttpError(409, 'Apenas saques pendentes podem ser cancelados');
    await refundWithdrawal(c, w, 'cancelled', null, null);
  });
  ok(res, null, { message: 'Saque cancelado' });
}));

export async function refundWithdrawal(c, w, status, adminId, note) {
  await c.query(`UPDATE withdrawals SET status=$2, reviewed_by=$3, admin_note=$4, processed_at=now() WHERE id=$1`, [w.id, status, adminId, note]);
  await move(c, w.user_id, 'blocked', -w.amount, 'withdrawal', null, {}, false);
  await move(c, w.user_id, 'withdraw', w.amount, 'withdrawal_refund', 'Estorno de saque', { withdrawalId: w.id });
  await c.query(`UPDATE transactions SET status='cancelled' WHERE user_id=$1 AND type='withdrawal' AND (metadata->>'withdrawalId')::bigint=$2`, [w.user_id, w.id]);
  await notify(c, w.user_id, 'alert', status === 'rejected' ? 'Saque recusado' : 'Saque cancelado',
    `O valor de ${w.amount.toFixed(2)} voltou ao seu saldo.${note ? ' Motivo: ' + note : ''}`);
}

// Fluxos de taxas/verificações pagas e de contestação foram removidos de propósito.
const gone = (_req, res) => res.status(410).json({ success: false, message: 'Funcionalidade indisponível: não há cobranças para liberar saques.' });
router.post('/cashout/tax/generate', auth, gone);
router.get('/cashout/tax/status/:id', auth, gone);
router.post('/cashout/personal-data', auth, gone);
router.get('/cashout/verification-code/:id', auth, gone);
router.get('/cashout/telegram-status/:id', auth, gone);
router.post('/cashout/verification/:rest(*)', auth, gone);
router.get('/cashout/verification/:rest(*)', auth, gone);
router.get('/chargeback/settings/public', (_req, res) => ok(res, { enabled: false }));
router.get('/chargeback/requests', auth, (_req, res) => ok(res, { requests: [] }));
router.all('/chargeback/:rest(*)', auth, gone);

/* ---------- vendas reais ---------- */
router.get('/sales', auth, wrap(async (req, res) => {
  const pg = page(req);
  const { rows } = await q(
    `SELECT s.*, p.name product_name FROM sales s LEFT JOIN products p ON p.id=s.product_id
     WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, [req.user.id]);
  ok(res, rows.map(s => ({ id: s.id, _id: s.id, productId: s.product_id, productName: s.product_name, adId: s.ad_id,
    amount: s.amount, commission: s.commission, status: s.status, createdAt: s.created_at })));
}));
router.get('/sales/stats', auth, wrap(async (req, res) => {
  const r = (await q(
    `SELECT count(*)::int total, COALESCE(sum(amount),0) revenue, COALESCE(sum(commission),0) commission,
            count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int today
     FROM sales WHERE user_id=$1 AND status='approved'`, [req.user.id])).rows[0];
  ok(res, { totalSales: r.total, totalRevenue: r.revenue, totalCommission: r.commission, todaySales: r.today });
}));

/* ---------- estatísticas ---------- */
router.get('/stats/dashboard', auth, wrap(async (req, res) => {
  const r = (await q(
    `SELECT (SELECT count(*) FROM ads WHERE user_id=$1 AND status='active')::int active_ads,
            (SELECT count(*) FROM ads WHERE user_id=$1)::int total_ads,
            (SELECT count(*) FROM sales WHERE user_id=$1 AND status='approved' AND created_at>=date_trunc('day',now()))::int today,
            (SELECT count(*) FROM sales WHERE user_id=$1 AND status='approved')::int total_sales,
            (SELECT COALESCE(sum(amount),0) FROM sales WHERE user_id=$1 AND status='approved') revenue,
            (SELECT COALESCE(sum(budget_spent),0) FROM ads WHERE user_id=$1) spent`, [req.user.id])).rows[0];
  ok(res, { overview: { activeAds: r.active_ads, totalAds: r.total_ads, todaySales: r.today, totalSales: r.total_sales,
    revenue: r.revenue, spent: r.spent, profit: r.revenue - r.spent } });
}));
router.get('/stats/performance', auth, wrap(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
  const { rows } = await q(
    `SELECT to_char(d,'YYYY-MM-DD') date,
            COALESCE((SELECT count(*) FROM sales s WHERE s.user_id=$1 AND s.status='approved' AND s.created_at::date=d::date),0)::int sales,
            COALESCE((SELECT sum(amount) FROM sales s WHERE s.user_id=$1 AND s.status='approved' AND s.created_at::date=d::date),0) revenue
     FROM generate_series(now()::date-($2::int-1), now()::date, '1 day') d ORDER BY d`, [req.user.id, days]);
  ok(res, { days: rows, daily: rows });
}));
router.get('/stats/ad/:id(\\d+)', auth, wrap(async (req, res) => {
  const a = (await q(`${AD_SELECT} WHERE a.id=$1 AND a.user_id=$2`, [req.params.id, req.user.id])).rows[0];
  if (!a) throw new HttpError(404, 'Anúncio não encontrado');
  ok(res, adOut(a));
}));

/* ---------- notificações ---------- */
const nOut = n => ({ id: n.id, _id: n.id, type: n.type, title: n.title, message: n.message, link: n.link, read: n.read, createdAt: n.created_at });
router.get('/notifications', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.user.id]);
  const now = Date.now();
  res.json({ success: true, data: rows.map(nOut), unreadCount: rows.filter(n => !n.read).length, serverNow: now, nextSyncAt: now + 30000 });
}));
router.put('/notifications/read-all', auth, wrap(async (req, res) => {
  await q('UPDATE notifications SET read=true WHERE user_id=$1 AND NOT read', [req.user.id]); ok(res, null);
}));
router.put('/notifications/:id(\\d+)/read', auth, wrap(async (req, res) => {
  await q('UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); ok(res, null);
}));
router.get('/notifications/vapid-key', auth, (_req, res) => process.env.VAPID_PUBLIC_KEY
  ? ok(res, { publicKey: process.env.VAPID_PUBLIC_KEY, key: process.env.VAPID_PUBLIC_KEY })
  : res.status(404).json({ success: false, message: 'Push não configurado' }));
router.post('/notifications/subscribe', auth, wrap(async (req, res) => {
  const s = req.body.subscription || req.body;
  if (!s?.endpoint) throw new HttpError(400, 'Assinatura inválida');
  await q(`INSERT INTO push_subscriptions (user_id,endpoint,keys) VALUES ($1,$2,$3)
           ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, keys=$3`, [req.user.id, s.endpoint, s.keys || {}]);
  ok(res, null);
}));

/* ---------- suporte (atendimento humano, sem respostas automáticas fingindo ser pessoa) ---------- */
const msgOut = m => ({ id: m.id, _id: m.id, sender: m.sender, role: m.sender, message: m.message, text: m.message,
  attachmentUrl: m.attachment_url, createdAt: m.created_at });
const ticketOut = (t, messages) => ({ id: t.id, _id: t.id, subject: t.subject, category: t.category, subcategory: t.subcategory,
  topicPath: t.topic_path, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at, ...(messages ? { messages: messages.map(msgOut) } : {}) });

router.post('/support/tickets', auth, wrap(async (req, res) => {
  const { subject, category, subcategory, topicPath, message, attachmentUrl } = req.body;
  if (!String(message || '').trim()) throw new HttpError(400, 'Escreva sua mensagem');
  const t = await tx(async c => {
    const t = (await c.query(
      `INSERT INTO support_tickets (user_id,subject,category,subcategory,topic_path) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, String(subject || 'Suporte').slice(0, 200), category || null, subcategory || null, JSON.stringify(topicPath || [])])).rows[0];
    await c.query('INSERT INTO support_messages (ticket_id,sender,message,attachment_url) VALUES ($1,$2,$3,$4)',
      [t.id, 'user', String(message).trim(), attachmentUrl || null]);
    return t;
  });
  res.status(201).json({ success: true, data: { ticket: ticketOut(t) } });
}));
router.get('/support/tickets', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM support_tickets WHERE user_id=$1 AND NOT is_chat ORDER BY updated_at DESC LIMIT 100', [req.user.id]);
  const tickets = rows.map(t => ticketOut(t));
  ok(res, { tickets, pendingTicket: tickets.find(t => ['open', 'in_progress'].includes(t.status)) || null });
}));
async function loadTicket(userId, id, c = { query: q }) {
  const t = (await c.query('SELECT * FROM support_tickets WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!t) throw new HttpError(404, 'Ticket não encontrado');
  const m = (await c.query('SELECT * FROM support_messages WHERE ticket_id=$1 ORDER BY id', [id])).rows;
  return ticketOut(t, m);
}
router.get('/support/tickets/:id(\\d+)', auth, wrap(async (req, res) => ok(res, { ticket: await loadTicket(req.user.id, req.params.id) })));
router.post('/support/tickets/:id(\\d+)/messages', auth, wrap(async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) throw new HttpError(400, 'Escreva sua mensagem');
  await loadTicket(req.user.id, req.params.id);
  await q('INSERT INTO support_messages (ticket_id,sender,message,attachment_url) VALUES ($1,$2,$3,$4)', [req.params.id, 'user', message, req.body.attachmentUrl || null]);
  await q(`UPDATE support_tickets SET updated_at=now(), status=CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END WHERE id=$1`, [req.params.id]);
  ok(res, { ticket: await loadTicket(req.user.id, req.params.id) });
}));
// Respostas automáticas de "atendente" não existem: apenas confirmam que não há envio.
router.post('/support/tickets/:id(\\d+)/auto-reply', auth, (_req, res) => ok(res, { delivered: false }));
router.post('/support/tickets/:id(\\d+)/keyword-reply', auth, (_req, res) => ok(res, { delivered: false }));
router.get('/support/fab-status', auth, (_req, res) => ok(res, { enabled: true, visible: true }));

async function chatTicket(userId) {
  const r = await q('SELECT * FROM support_tickets WHERE user_id=$1 AND is_chat', [userId]);
  if (r.rows[0]) return r.rows[0];
  return (await q(`INSERT INTO support_tickets (user_id,subject,is_chat) VALUES ($1,'Chat de suporte',true) RETURNING *`, [userId])).rows[0];
}
router.post('/support/chat', auth, wrap(async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) throw new HttpError(400, 'Mensagem vazia');
  const t = await chatTicket(req.user.id);
  const m = (await q('INSERT INTO support_messages (ticket_id,sender,message) VALUES ($1,$2,$3) RETURNING *', [t.id, 'user', message])).rows[0];
  await q(`UPDATE support_tickets SET updated_at=now(), status='open' WHERE id=$1`, [t.id]);
  ok(res, { message: msgOut(m) });
}));
router.get('/support/history', auth, wrap(async (req, res) => {
  const t = await chatTicket(req.user.id);
  const m = (await q('SELECT * FROM support_messages WHERE ticket_id=$1 ORDER BY id', [t.id])).rows;
  ok(res, { messages: m.map(msgOut) });
}));

/* ---------- webhook de vendas reais (afiliados) ---------- */
router.post('/postbacks/sale', wrap(async (req, res) => {
  const secret = process.env.POSTBACK_SECRET;
  const given = String(req.headers['x-postback-secret'] || '');
  if (!secret) throw new HttpError(503, 'Postback não configurado');
  const a = Buffer.from(given), b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Segredo inválido');
  const externalId = String(req.body.externalId || '').trim();
  const amount = num(req.body.amount, 'Valor');
  if (!externalId || amount < 0) throw new HttpError(400, 'Dados da venda inválidos');
  const result = await tx(async c => {
    const aff = (await c.query('SELECT * FROM affiliations WHERE code=$1', [String(req.body.affiliateCode || '')])).rows[0];
    if (!aff) throw new HttpError(404, 'Afiliação não encontrada');
    const prod = (await c.query('SELECT * FROM products WHERE id=$1', [aff.product_id])).rows[0];
    const commission = Math.round(amount * prod.commission_percentage) / 100;
    const ad = req.body.adId ? (await c.query(`SELECT id FROM ads WHERE id=$1 AND user_id=$2`, [req.body.adId, aff.user_id])).rows[0] : null;
    const ins = await c.query(
      `INSERT INTO sales (user_id,product_id,ad_id,external_id,amount,commission) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (external_id) DO NOTHING RETURNING id`, [aff.user_id, prod.id, ad?.id ?? null, externalId, amount, commission]);
    if (!ins.rowCount) return { duplicate: true };
    await move(c, aff.user_id, 'withdraw', commission, 'sale', `Comissão: ${prod.name}`, { saleId: ins.rows[0].id });
    await notify(c, aff.user_id, 'sale', 'Nova venda realizada!', `Você ganhou ${commission.toFixed(2)} de comissão em ${prod.name}.`, '/stats');
    return { saleId: ins.rows[0].id, commission };
  });
  ok(res, result);
}));

// Telemetria do mini app: aceita e descarta.
router.post('/tg/:kind', (_req, res) => res.status(204).end());
