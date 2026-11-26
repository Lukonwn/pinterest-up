CREATE TABLE users (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  level            TEXT NOT NULL DEFAULT 'iniciante',
  is_international BOOLEAN NOT NULL DEFAULT FALSE,
  balance          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),          -- crédito para anúncios
  withdraw_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (withdraw_balance >= 0), -- ganhos sacáveis
  blocked_balance  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (blocked_balance >= 0),  -- retido em saques pendentes
  has_recharged    BOOLEAN NOT NULL DEFAULT FALSE,
  company_data     JSONB,
  token_version    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE products (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'Variados',
  currency    TEXT NOT NULL DEFAULT 'BRL' CHECK (currency IN ('BRL','USD')),
  price       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_percentage BETWEEN 0 AND 100),
  image       TEXT,
  images      JSONB NOT NULL DEFAULT '[]',
  external_url TEXT,
  hot_score   INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category) WHERE active;
CREATE INDEX products_search_idx ON products USING gin (to_tsvector('portuguese', name || ' ' || description));

CREATE TABLE affiliations (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE TABLE pins (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  link        TEXT,
  category    TEXT NOT NULL DEFAULT 'Variados',
  likes_count INTEGER NOT NULL DEFAULT 0,
  views_count INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pins_category_idx ON pins (lower(category)) WHERE active;

CREATE TABLE pin_likes (
  pin_id  BIGINT NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pin_id, user_id)
);

CREATE TABLE ads (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','finished')),
  budget_total NUMERIC(14,2) NOT NULL CHECK (budget_total > 0),
  budget_spent NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (budget_spent >= 0),
  creative    JSONB NOT NULL DEFAULT '{}',
  strategy    TEXT NOT NULL DEFAULT 'auto',
  targeting   JSONB NOT NULL DEFAULT '{}',
  automation_rules JSONB NOT NULL DEFAULT '[]',
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX ads_user_idx ON ads (user_id, created_at DESC);

-- Vendas REAIS recebidas via postback autenticado. Nada é simulado.
CREATE TABLE sales (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id   BIGINT REFERENCES products(id) ON DELETE SET NULL,
  ad_id        BIGINT REFERENCES ads(id) ON DELETE SET NULL,
  external_id  TEXT NOT NULL UNIQUE,
  amount       NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  commission   NUMERIC(14,2) NOT NULL CHECK (commission >= 0),
  status       TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','refunded')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sales_user_idx ON sales (user_id, created_at DESC);

CREATE TABLE withdrawals (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  pix_key       TEXT NOT NULL,
  pix_key_type  TEXT NOT NULL CHECK (pix_key_type IN ('cpf','cnpj','email','phone','random')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected','cancelled')),
  admin_note    TEXT,
  reviewed_by   BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC);
CREATE INDEX withdrawals_status_idx ON withdrawals (status, created_at);
CREATE UNIQUE INDEX withdrawals_one_pending_uq ON withdrawals (user_id) WHERE status = 'pending';

-- Livro-razão: toda movimentação de saldo gera uma linha.
CREATE TABLE transactions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet        TEXT NOT NULL CHECK (wallet IN ('balance','withdraw')),
  type          TEXT NOT NULL,  -- credit, ad_spend, ad_refund, sale, withdrawal, withdrawal_refund, admin_adjust
  amount        NUMERIC(14,2) NOT NULL,           -- positivo entra, negativo sai
  balance_after NUMERIC(14,2) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'completed',
  description   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_user_idx ON transactions (user_id, created_at DESC);

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  link       TEXT,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  keys       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  category    TEXT,
  subcategory TEXT,
  topic_path  JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  is_chat     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_user_idx ON support_tickets (user_id, updated_at DESC);

CREATE TABLE support_messages (
  id             BIGSERIAL PRIMARY KEY,
  ticket_id      BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender         TEXT NOT NULL CHECK (sender IN ('user','admin')),
  message        TEXT NOT NULL,
  attachment_url TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('feature_flags', '{"ATUALIZACAO_NOVA":false,"MINI_APP_HEADER":false,"DESKTOP_GUARD":false,"DESKTOP_GUARD_URL":"","DESKTOP_GUARD_BYPASS":false}'),
  ('limits', '{"minAdBudget":10,"minWithdrawBRL":20,"minWithdrawUSD":5}'),
  ('withdraw_auto_approve', '{"enabled":false,"maxAmount":0}');
