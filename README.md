# pinterest-up

Frontend (bundle estático em `css/`, `js/`, `images/`) + backend Node/Express + PostgreSQL.

## Rodar localmente
```
docker compose up -d          # Postgres
cp .env.example .env          # ajuste os valores
npm install
npm start                     # aplica migrations, cria o admin (ADMIN_EMAIL/ADMIN_PASSWORD) e sobe em :8080
npm test                      # teste de integração contra o Postgres local
```

## Variáveis
| Variável | Obrigatória | Uso |
|---|---|---|
| `DATABASE_URL` | sim | Postgres (no Railway: `${{Postgres.DATABASE_URL}}`) |
| `JWT_SECRET` | sim em produção | assinatura dos tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | recomendado | cria/promove o administrador no boot |
| `POSTBACK_SECRET` | opcional | habilita `POST /api/postbacks/sale` (vendas reais de afiliados) |
| `VAPID_PUBLIC_KEY` | opcional | chave pública do Web Push |

## Modelo de dados (`migrations/001_init.sql`)
users, products, affiliations, pins, pin_likes, ads, sales, withdrawals, transactions (livro-razão),
notifications, push_subscriptions, support_tickets, support_messages, settings, schema_migrations.

## Decisões deliberadas
- Saque sem taxa: `/cashout/fee` retorna 0; fluxos de taxa/verificação paga e `/chargeback/*` respondem 410.
- Nenhum dado de cartão é coletado (`/balance/check` responde 410).
- Anúncios reservam o orçamento do saldo; encerrar devolve o que não foi usado. Não há vendas simuladas:
  vendas só entram via `POST /api/postbacks/sale` autenticado por `X-Postback-Secret`.
- Suporte é atendimento humano pelo painel admin; não há respostas automáticas fingindo ser atendente.
- "Aprovar saque" no admin registra que o PIX foi enviado; o envio em si é feito fora do sistema.
