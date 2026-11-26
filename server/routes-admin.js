import express from 'express';
import bcrypt from 'bcryptjs';
import { q, tx, move, HttpError } from './db.js';
import { ok, wrap, publicUser, productOut, pinOut, page, pagination, num, notify, getSetting, setSetting } from './util.js';
import { refundWithdrawal } from './routes-user.js';

export const admin = express.Router(); // montado em /swagger-control após auth + adminOnly

const like = s => `%${String(s).trim()}%`;

/* ---------- conta do admin ---------- */
admin.get('/account', (req, res) => ok(res, { ...publicUser(req.user), twoFactorEnabled: false }));
admin.put('/account/profile', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) throw new HttpError(400, 'Nome inválido');
  const { rows } = await q('UPDATE users SET name=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.user.id, name]);
  ok(res, publicUser(rows[0]));
}));
admin.put('/account/password', wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) throw new HttpError(400, 'Senha atual incorreta');
  if (String(newPassword || '').length < 8) throw new HttpError(400, 'A nova senha deve ter ao menos 8 caracteres');
  await q('UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1', [req.user.id, await bcrypt.hash(newPassword, 10)]);
  ok(res, null, { message: 'Senha alterada. Faça login novamente.' });
}));
admin.post('/account/logout-all', wrap(async (req, res) => {
  await q('UPDATE users SET token_version=token_version+1 WHERE id=$1', [req.user.id]); ok(res, null);
}));

/* ---------- dashboard ---------- */
admin.get('/dashboard', wrap(async (_req, res) => {
  const r = (await q(
    `SELECT (SELECT count(*) FROM users)::int users,
            (SELECT count(*) FROM users WHERE created_at>=now()-interval '7 days')::int new_users,
            (SELECT count(*) FROM ads WHERE status='active')::int active_ads,
            (SELECT count(*) FROM sales WHERE status='approved')::int sales,
            (SELECT COALESCE(sum(amount),0) FROM sales WHERE status='approved') revenue,
            (SELECT count(*) FROM withdrawals WHERE status='pending')::int pending_withdrawals,
            (SELECT COALESCE(sum(amount),0) FROM withdrawals WHERE status='completed') paid_out,
            (SELECT count(*) FROM support_tickets WHERE status IN ('open','in_progress'))::int open_tickets`)).rows[0];
  ok(res, {
    totalUsers: r.users, newUsers: r.new_users, activeAds: r.active_ads, totalSales: r.sales, totalRevenue: r.revenue,
    pendingWithdrawals: r.pending_withdrawals, totalPaidOut: r.paid_out, openTickets: r.open_tickets,
  });
}));

/* ---------- usuários ---------- */
admin.get('/users', wrap(async (req, res) => {
  const pg = page(req);
  const v = [], w = ['true'];
  if (req.query.search) { v.push(like(req.query.search)); w.push(`(name ILIKE $1 OR email ILIKE $1)`); }
  if (req.query.status) { v.push(req.query.status); w.push(`status=$${v.length}`); }
  const where = w.join(' AND ');
  const total = (await q(`SELECT count(*)::int c FROM users WHERE ${where}`, v)).rows[0].c;
  const { rows } = await q(`SELECT * FROM users WHERE ${where} ORDER BY id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, v);
  ok(res, rows.map(publicUser), { pagination: pagination(total, pg) });
}));
admin.get('/users/:id(\\d+)', wrap(async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!u) throw new HttpError(404, 'Usuário não encontrado');
  const tr = (await q('SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [u.id])).rows;
  ok(res, { ...publicUser(u), transactions: tr });
}));
admin.put('/users/:id(\\d+)', wrap(async (req, res) => {
  const b = req.body, sets = [], vals = [req.params.id];
  const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
  if (b.name !== undefined) add('name', String(b.name).trim());
  if (b.email !== undefined) add('email', String(b.email).trim().toLowerCase());
  if (b.role !== undefined) { if (!['user', 'admin'].includes(b.role)) throw new HttpError(400, 'Role inválida'); add('role', b.role); }
  if (b.level !== undefined) add('level', String(b.level));
  if (!sets.length) throw new HttpError(400, 'Nada para atualizar');
  const r = await q(`UPDATE users SET ${sets.join(',')}, updated_at=now(), token_version=token_version+1 WHERE id=$1 RETURNING *`, vals)
    .catch(e => { if (e.code === '23505') throw new HttpError(409, 'E-mail já em uso'); throw e; });
  if (!r.rows[0]) throw new HttpError(404, 'Usuário não encontrado');
  ok(res, publicUser(r.rows[0]));
}));
admin.patch('/users/:id(\\d+)/toggle-status', wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'Você não pode bloquear a própria conta');
  const r = await q(`UPDATE users SET status=CASE WHEN status='active' THEN 'blocked' ELSE 'active' END, token_version=token_version+1 WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!r.rows[0]) throw new HttpError(404, 'Usuário não encontrado');
  ok(res, publicUser(r.rows[0]));
}));
// Ajuste manual de saldo, sempre registrado no livro-razão com o admin responsável.
admin.patch('/users/:id(\\d+)/adjust-balance', wrap(async (req, res) => {
  const amount = num(req.body.amount, 'Valor');
  const wallet = req.body.wallet === 'withdraw' ? 'withdraw' : 'balance';
  if (!amount) throw new HttpError(400, 'Valor não pode ser zero');
  const u = await tx(async c => {
    await move(c, req.params.id, wallet, amount, 'admin_adjust', String(req.body.reason || 'Ajuste administrativo'), { adminId: req.user.id });
    if (amount > 0 && wallet === 'balance') await c.query('UPDATE users SET has_recharged=true WHERE id=$1', [req.params.id]);
    return (await c.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  });
  ok(res, publicUser(u));
}));

/* ---------- saques ---------- */
const wdAdmin = w => ({ id: w.id, _id: w.id, amount: w.amount, requestedAmount: w.amount, pixKey: w.pix_key, pixKeyType: w.pix_key_type,
  status: w.status, note: w.admin_note, createdAt: w.created_at, processedAt: w.processed_at,
  user: { id: w.user_id, _id: w.user_id, name: w.u_name, email: w.u_email, companyData: w.u_company } });
const WD = `SELECT w.*, u.name u_name, u.email u_email, u.company_data u_company FROM withdrawals w JOIN users u ON u.id=w.user_id`;
admin.get('/withdrawals', wrap(async (req, res) => {
  const pg = page(req); const v = [], w = ['true'];
  if (req.query.status) { v.push(req.query.status); w.push(`w.status=$1`); }
  const total = (await q(`SELECT count(*)::int c FROM withdrawals w WHERE ${w.join(' AND ')}`, v)).rows[0].c;
  const { rows } = await q(`${WD} WHERE ${w.join(' AND ')} ORDER BY w.id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, v);
  ok(res, rows.map(wdAdmin), { pagination: pagination(total, pg) });
}));
admin.get('/withdrawals/settings/auto-approve', wrap(async (_req, res) => ok(res, await getSetting('withdraw_auto_approve'))));
admin.put('/withdrawals/settings/auto-approve', wrap(async (req, res) => {
  const v = { enabled: !!req.body.enabled, maxAmount: Math.max(num(req.body.maxAmount ?? 0, 'Valor'), 0) };
  await setSetting('withdraw_auto_approve', v); ok(res, v);
}));
admin.get('/withdrawals/settings/fee', (_req, res) => ok(res, { enabled: false, amount: 0 }));
admin.put('/withdrawals/settings/fee', (_req, res) => res.status(410).json({ success: false, message: 'Taxas para saque não são suportadas.' }));
admin.get('/withdrawals/:id(\\d+)', wrap(async (req, res) => {
  const w = (await q(`${WD} WHERE w.id=$1`, [req.params.id])).rows[0];
  if (!w) throw new HttpError(404, 'Saque não encontrado');
  ok(res, wdAdmin(w));
}));
// "Aprovar" = o admin confirma que o PIX foi enviado ao usuário (o envio em si é feito fora deste sistema).
admin.post('/withdrawals/:id(\\d+)/approve', wrap(async (req, res) => {
  await tx(async c => {
    const w = (await c.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!w) throw new HttpError(404, 'Saque não encontrado');
    if (w.status !== 'pending') throw new HttpError(409, 'Saque já processado');
    await c.query(`UPDATE withdrawals SET status='completed', reviewed_by=$2, admin_note=$3, processed_at=now() WHERE id=$1`, [w.id, req.user.id, req.body.note || null]);
    await move(c, w.user_id, 'blocked', -w.amount, 'withdrawal', null, {}, false);
    await c.query(`UPDATE transactions SET status='completed' WHERE user_id=$1 AND type='withdrawal' AND (metadata->>'withdrawalId')::bigint=$2`, [w.user_id, w.id]);
    await notify(c, w.user_id, 'success', 'Saque aprovado', `Seu saque de ${w.amount.toFixed(2)} foi aprovado e enviado para sua chave PIX.`);
  });
  ok(res, null, { message: 'Saque aprovado' });
}));
admin.post('/withdrawals/:id(\\d+)/reject', wrap(async (req, res) => {
  await tx(async c => {
    const w = (await c.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!w) throw new HttpError(404, 'Saque não encontrado');
    if (w.status !== 'pending') throw new HttpError(409, 'Saque já processado');
    await refundWithdrawal(c, w, 'rejected', req.user.id, req.body.reason || req.body.note || null);
  });
  ok(res, null, { message: 'Saque recusado e valor devolvido' });
}));

/* ---------- pins ---------- */
const pinIn = b => {
  const image = String(b.image || b.imageUrl || b.images?.orig?.url || '').trim();
  if (!/^https?:\/\//i.test(image)) throw new HttpError(400, 'URL da imagem inválida');
  return [String(b.title || '').slice(0, 300), String(b.description || ''), image, b.width || null, b.height || null,
    b.link || null, String(b.category || 'Variados'), b.active !== false];
};
const PIN_COLS = 'title,description,image,width,height,link,category,active';
admin.get('/pins', wrap(async (req, res) => {
  const pg = page(req); const v = [], w = ['true'];
  if (req.query.search) { v.push(like(req.query.search)); w.push('(title ILIKE $1 OR description ILIKE $1)'); }
  if (req.query.category) { v.push(req.query.category); w.push(`category=$${v.length}`); }
  const total = (await q(`SELECT count(*)::int c FROM pins WHERE ${w.join(' AND ')}`, v)).rows[0].c;
  const { rows } = await q(`SELECT * FROM pins WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, v);
  ok(res, rows.map(p => ({ ...pinOut(p), active: p.active })), { pagination: pagination(total, pg) });
}));
admin.post('/pins', wrap(async (req, res) => {
  const r = await q(`INSERT INTO pins (${PIN_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, pinIn(req.body));
  res.status(201).json({ success: true, data: pinOut(r.rows[0]) });
}));
const pinsBulk = wrap(async (req, res) => {
  const list = req.body.pins || req.body.items; if (!Array.isArray(list) || !list.length || list.length > 500) throw new HttpError(400, 'Envie de 1 a 500 pins');
  const rows = list.map(pinIn);
  await tx(async c => { for (const r of rows) await c.query(`INSERT INTO pins (${PIN_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, r); });
  res.status(201).json({ success: true, data: { created: rows.length } });
});
admin.post('/pins/bulk', pinsBulk);
admin.post('/import-pins', pinsBulk);
admin.put('/pins/:id(\\d+)', wrap(async (req, res) => {
  const r = await q(`UPDATE pins SET (${PIN_COLS}) = ($2,$3,$4,$5,$6,$7,$8,$9) WHERE id=$1 RETURNING *`, [req.params.id, ...pinIn(req.body)]);
  if (!r.rows[0]) throw new HttpError(404, 'Pin não encontrado');
  ok(res, pinOut(r.rows[0]));
}));
admin.delete('/pins/:id(\\d+)', wrap(async (req, res) => {
  const r = await q('DELETE FROM pins WHERE id=$1', [req.params.id]);
  if (!r.rowCount) throw new HttpError(404, 'Pin não encontrado'); ok(res, null);
}));
admin.get('/export-pins', wrap(async (_req, res) => ok(res, (await q('SELECT title,description,image,width,height,link,category,active FROM pins ORDER BY id')).rows)));

/* ---------- produtos ---------- */
const prodIn = b => {
  const price = num(b.price?.value ?? b.price ?? 0, 'Preço');
  const pct = b.commissionPercentage ?? b.affiliation?.commission?.percentage ?? 0;
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Nome é obrigatório');
  if (price < 0) throw new HttpError(400, 'Preço inválido');
  const images = Array.isArray(b.images) ? b.images.filter(x => typeof x === 'string') : [];
  return [name, String(b.description || ''), String(b.category || 'Variados'), b.currency === 'USD' ? 'USD' : 'BRL', price,
    Math.min(Math.max(num(pct, 'Comissão'), 0), 100), b.image || images[0] || null, JSON.stringify(images), b.externalUrl || null, b.active !== false];
};
const PROD_COLS = 'name,description,category,currency,price,commission_percentage,image,images,external_url,active';
admin.get('/products', wrap(async (req, res) => {
  const pg = page(req); const v = [], w = ['true'];
  if (req.query.search) { v.push(like(req.query.search)); w.push('(name ILIKE $1 OR description ILIKE $1)'); }
  if (req.query.category) { v.push(req.query.category); w.push(`category=$${v.length}`); }
  const total = (await q(`SELECT count(*)::int c FROM products WHERE ${w.join(' AND ')}`, v)).rows[0].c;
  const { rows } = await q(`SELECT * FROM products WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, v);
  ok(res, rows.map(p => productOut(p)), { pagination: pagination(total, pg) });
}));
admin.post('/products', wrap(async (req, res) => {
  const r = await q(`INSERT INTO products (${PROD_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, prodIn(req.body));
  res.status(201).json({ success: true, data: productOut(r.rows[0]) });
}));
const productsBulk = wrap(async (req, res) => {
  const list = req.body.products || req.body.items; if (!Array.isArray(list) || !list.length || list.length > 500) throw new HttpError(400, 'Envie de 1 a 500 produtos');
  const rows = list.map(prodIn);
  await tx(async c => { for (const r of rows) await c.query(`INSERT INTO products (${PROD_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r); });
  res.status(201).json({ success: true, data: { created: rows.length } });
});
admin.post('/products/bulk', productsBulk);
admin.post('/import-products', productsBulk);
admin.put('/products/:id(\\d+)', wrap(async (req, res) => {
  const r = await q(`UPDATE products SET (${PROD_COLS}, updated_at) = ($2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()) WHERE id=$1 RETURNING *`, [req.params.id, ...prodIn(req.body)]);
  if (!r.rows[0]) throw new HttpError(404, 'Produto não encontrado');
  ok(res, productOut(r.rows[0]));
}));
// Produtos com afiliações/anúncios são desativados (preserva histórico); os demais são removidos.
admin.delete('/products/:id(\\d+)', wrap(async (req, res) => {
  const used = (await q('SELECT (SELECT count(*) FROM ads WHERE product_id=$1)+(SELECT count(*) FROM affiliations WHERE product_id=$1) n', [req.params.id])).rows[0].n;
  if (used > 0) { await q('UPDATE products SET active=false WHERE id=$1', [req.params.id]); return ok(res, { deactivated: true }); }
  const r = await q('DELETE FROM products WHERE id=$1', [req.params.id]);
  if (!r.rowCount) throw new HttpError(404, 'Produto não encontrado'); ok(res, { deleted: true });
}));
admin.get('/export-products', wrap(async (_req, res) => ok(res, (await q(`SELECT ${PROD_COLS} FROM products ORDER BY id`)).rows)));

/* ---------- suporte ---------- */
admin.get('/support/stats', wrap(async (_req, res) => {
  const r = (await q(`SELECT count(*) FILTER (WHERE status='open')::int open, count(*) FILTER (WHERE status='in_progress')::int in_progress,
    count(*) FILTER (WHERE status IN ('resolved','closed'))::int closed, count(*)::int total FROM support_tickets`)).rows[0];
  ok(res, r);
}));
admin.get('/support/tickets', wrap(async (req, res) => {
  const pg = page(req); const v = [], w = ['true'];
  if (req.query.status) { v.push(req.query.status); w.push('t.status=$1'); }
  const { rows } = await q(
    `SELECT t.*, u.name u_name, u.email u_email FROM support_tickets t JOIN users u ON u.id=t.user_id
     WHERE ${w.join(' AND ')} ORDER BY t.updated_at DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, v);
  ok(res, rows.map(t => ({ id: t.id, _id: t.id, subject: t.subject, category: t.category, status: t.status, updatedAt: t.updated_at,
    createdAt: t.created_at, user: { id: t.user_id, name: t.u_name, email: t.u_email } })));
}));
admin.get('/support/tickets/:id(\\d+)', wrap(async (req, res) => {
  const t = (await q(`SELECT t.*, u.name u_name, u.email u_email FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=$1`, [req.params.id])).rows[0];
  if (!t) throw new HttpError(404, 'Ticket não encontrado');
  const m = (await q('SELECT * FROM support_messages WHERE ticket_id=$1 ORDER BY id', [t.id])).rows;
  ok(res, { ticket: { id: t.id, _id: t.id, subject: t.subject, category: t.category, status: t.status, createdAt: t.created_at,
    user: { id: t.user_id, name: t.u_name, email: t.u_email },
    messages: m.map(x => ({ id: x.id, _id: x.id, sender: x.sender, message: x.message, attachmentUrl: x.attachment_url, createdAt: x.created_at })) } });
}));
admin.post('/support/tickets/:id(\\d+)/reply', wrap(async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) throw new HttpError(400, 'Mensagem vazia');
  await tx(async c => {
    const t = (await c.query('SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!t) throw new HttpError(404, 'Ticket não encontrado');
    await c.query('INSERT INTO support_messages (ticket_id,sender,message,attachment_url) VALUES ($1,$2,$3,$4)', [t.id, 'admin', message, req.body.attachmentUrl || null]);
    await c.query(`UPDATE support_tickets SET status='in_progress', updated_at=now() WHERE id=$1 AND status='open'`, [t.id]);
    await c.query(`UPDATE support_tickets SET updated_at=now() WHERE id=$1`, [t.id]);
    await notify(c, t.user_id, 'support', 'Nova resposta do suporte', message.slice(0, 140), '/support');
  });
  ok(res, null, { message: 'Resposta enviada' });
}));
admin.patch('/support/tickets/:id(\\d+)/status', wrap(async (req, res) => {
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(req.body.status)) throw new HttpError(400, 'Status inválido');
  const r = await q('UPDATE support_tickets SET status=$2, updated_at=now() WHERE id=$1', [req.params.id, req.body.status]);
  if (!r.rowCount) throw new HttpError(404, 'Ticket não encontrado'); ok(res, null);
}));

/* ---------- comunicados ---------- */
admin.post('/notifications/broadcast', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim(), message = String(req.body.message || '').trim();
  if (!title) throw new HttpError(400, 'Título é obrigatório');
  const r = await q(
    `INSERT INTO notifications (user_id,type,title,message,link)
     SELECT id,$1,$2,$3,$4 FROM users WHERE status='active'`, [req.body.type || 'info', title, message, req.body.link || null]);
  ok(res, { recipients: r.rowCount });
}));

/* ---------- relatórios / configurações ---------- */
admin.get('/reports/transactions', wrap(async (req, res) => {
  const pg = page(req);
  const { rows } = await q(`SELECT t.*, u.email FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`);
  ok(res, rows);
}));
admin.get('/payments', (_req, res) => ok(res, [], { pagination: { totalItems: 0, page: 1, limit: 50, totalPages: 1 } }));
admin.get('/settings/limits', wrap(async (_req, res) => ok(res, await getSetting('limits'))));
admin.put('/settings/limits', wrap(async (req, res) => {
  const cur = await getSetting('limits'), v = { ...cur };
  for (const k of ['minAdBudget', 'minWithdrawBRL', 'minWithdrawUSD']) if (req.body[k] !== undefined) v[k] = Math.max(num(req.body[k], k), 0);
  await setSetting('limits', v); ok(res, v);
}));
for (const key of ['mini-app', 'desktop-guard']) {
  admin.get(`/${key}/settings`, wrap(async (_req, res) => ok(res, await getSetting('feature_flags'))));
  admin.put(`/${key}/settings`, wrap(async (req, res) => {
    const cur = await getSetting('feature_flags'); const allowed = Object.keys(cur);
    const v = { ...cur }; for (const k of allowed) if (req.body[k] !== undefined) v[k] = req.body[k];
    await setSetting('feature_flags', v); ok(res, v);
  }));
}
admin.use((_req, res) => res.status(404).json({ success: false, message: 'Recurso administrativo não implementado' }));
