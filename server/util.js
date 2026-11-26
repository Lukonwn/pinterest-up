import jwt from 'jsonwebtoken';
import { q, HttpError } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me');

export const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const signToken = u => jwt.sign({ sub: u.id, tv: u.token_version }, JWT_SECRET, { expiresIn: '30d' });

export const auth = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Não autenticado');
  let p;
  try { p = jwt.verify(h.slice(7), JWT_SECRET); } catch { throw new HttpError(401, 'Sessão inválida ou expirada'); }
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [p.sub]);
  const u = rows[0];
  if (!u || u.token_version !== p.tv) throw new HttpError(401, 'Sessão inválida ou expirada');
  if (u.status !== 'active') throw new HttpError(403, 'Conta bloqueada');
  req.user = u;
  next();
});

export const adminOnly = (req, _res, next) =>
  req.user?.role === 'admin' ? next() : next(new HttpError(403, 'Acesso negado'));

export const publicUser = u => ({
  id: u.id, _id: u.id, name: u.name, email: u.email, role: u.role, level: u.level,
  status: u.status, isInternational: u.is_international, balance: u.balance,
  withdrawBalance: u.withdraw_balance, blockedBalance: u.blocked_balance,
  hasRecharged: u.has_recharged,
  companyData: u.company_data ? { ...u.company_data, filled: true } : { filled: false },
  createdAt: u.created_at,
});

export const productOut = (p, extra = {}) => {
  const price = p.price;
  const commission = Math.round(price * p.commission_percentage) / 100;
  return {
    id: p.id, _id: p.id, name: p.name, description: p.description, category: p.category,
    currency: p.currency, price, image: p.image, images: p.images || [],
    hasRealImage: !!p.image, externalUrl: p.external_url, active: p.active,
    affiliation: { commission: { price: commission, percentage: p.commission_percentage, currency: p.currency } },
    ...extra,
  };
};

export const pinOut = (p, isLiked = false) => ({
  id: p.id, _id: p.id, title: p.title, description: p.description, image: p.image,
  images: { orig: { url: p.image, width: p.width, height: p.height }, '474x': { url: p.image, width: p.width, height: p.height } },
  link: p.link, category: p.category, likes: p.likes_count, views: p.views_count, isLiked, createdAt: p.created_at,
});

export const page = req => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const pg = Math.max(parseInt(req.query.page) || 1, 1);
  return { limit, page: pg, offset: (pg - 1) * limit };
};
export const pagination = (total, { limit, page }) => ({ totalItems: total, page, limit, totalPages: Math.ceil(total / limit) || 1 });

export const num = (v, name = 'valor') => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${name} inválido`);
  return Math.round(n * 100) / 100;
};

export async function notify(c, userId, type, title, message, link = null) {
  await c.query('INSERT INTO notifications (user_id,type,title,message,link) VALUES ($1,$2,$3,$4,$5)',
    [userId, type, title, message, link]);
}

export async function getSetting(key, fallback = {}) {
  const { rows } = await q('SELECT value FROM settings WHERE key=$1', [key]);
  return rows[0]?.value ?? fallback;
}
export const setSetting = (key, value) => q(
  `INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, value]);
