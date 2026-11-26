import express from 'express';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool, q, HttpError } from './db.js';
import { JWT_SECRET, auth, adminOnly } from './util.js';
import { router } from './routes-user.js';
import { admin } from './routes-admin.js';
import { migrate } from '../scripts/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    next();
  });

  app.use('/api/swagger-control', auth, adminOnly, admin);
  app.use('/api', router);
  app.use('/api', (_req, res) => res.status(404).json({ success: false, message: 'Rota não encontrada' }));

  // Frontend estático (somente as pastas públicas) com fallback de SPA
  for (const d of ['css', 'js', 'images', 'assets']) app.use(`/${d}`, express.static(path.join(root, d), { maxAge: '1h' }));
  app.get('/cash.mp3', (_req, res) => res.status(404).end());
  app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'JSON inválido');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ success: false, message: status >= 500 ? 'Erro interno' : err.message, ...(err.code ? { error: err.code } : {}) });
  });
  return app;
}

async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < 8) throw new Error('ADMIN_PASSWORD precisa ter ao menos 8 caracteres');
  const hash = await bcrypt.hash(password, 10);
  await q(`INSERT INTO users (name,email,password_hash,role) VALUES ('Administrador',$1,$2,'admin')
           ON CONFLICT (lower(email)) DO UPDATE SET role='admin'`, [email, hash]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL não definida'); process.exit(1); }
  if (!JWT_SECRET) { console.error('JWT_SECRET não definida'); process.exit(1); }
  await migrate(pool);
  await bootstrapAdmin();
  const port = Number(process.env.PORT || 8080);
  buildApp().listen(port, '0.0.0.0', () => console.log(`pinterest-up ouvindo em :${port}`));
}
