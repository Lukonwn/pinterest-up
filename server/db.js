import pg from 'pg';

// NUMERIC -> number (valores monetários cabem com folga em double para 2 casas)
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

const COL = { balance: 'balance', withdraw: 'withdraw_balance', blocked: 'blocked_balance' };

/** Altera um saldo e grava no livro-razão, dentro de uma transação. */
export async function move(c, userId, wallet, delta, type, description, metadata = {}, ledger = true) {
  const col = COL[wallet];
  const r = await c.query(
    `UPDATE users SET ${col} = ${col} + $2, updated_at = now() WHERE id = $1 RETURNING ${col} AS v`,
    [userId, delta],
  ).catch(e => { if (e.code === '23514') throw new HttpError(400, 'Saldo insuficiente', 'INSUFFICIENT_FUNDS'); throw e; });
  if (!r.rowCount) throw new HttpError(404, 'Usuário não encontrado');
  if (ledger && wallet !== 'blocked') {
    await c.query(
      `INSERT INTO transactions (user_id, wallet, type, amount, balance_after, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, wallet, type, delta, r.rows[0].v, description, metadata],
    );
  }
  return r.rows[0].v;
}

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
