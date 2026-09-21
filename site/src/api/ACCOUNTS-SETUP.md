# Console accounts — switching them on

The console works without any of this; accounts add sign-in, synced tracked grants, and alerts the site
runs for you. Code: `ops/api/account.js` (bundled to `site/src/api/account.mjs` by `node ops/api/build.mjs`),
tests: `node ops/api/test.mjs`. Design: `site/ACCOUNTS.md`.

## 1. A database

In the Vercel dashboard for the site's project: Storage → Create → Neon (Postgres) → connect it to the
project. That sets `DATABASE_URL`. The tables are created on first use.

## 2. Two secrets

    openssl rand -hex 32        # run twice, one value for each

    npx vercel env add SESSION_SECRET production --cwd web     # Secret
    npx vercel env add CRON_SECRET production --cwd web        # Secret

`SESSION_SECRET` signs the sign-in cookie; changing it signs everybody out. `CRON_SECRET` lets the scheduler
ask the site to run everyone's rules.

## 3. Telegram (optional, for alerts to arrive)

Create a bot with @BotFather, then:

    npx vercel env add TELEGRAM_BOT_TOKEN production --cwd web  # Secret

Each person messages that bot, reads their chat id, and saves it under Your account. Without the token, rules
still run and what they would have sent is shown on Your account.

## 4. Deploy, and the 15-minute clock

    npx vercel --cwd web --prod

Vercel's cron runs the rules once a day on the Hobby plan. For every 15 minutes, put the same CRON_SECRET in
`ops/alerts.env` as `CONSOLE_CRON_SECRET` on the node machine and run `ops/install-cron.sh`.

## Check it

    curl "https://www.wardaprotocol.com/api/account?op=nonce"      # {"ok":true,"nonce":...}

Then Your account → connect a wallet → Sign in.

## 5. Following grants that move (verifier 0.2.3)

A grant moves with every payment. With one payee address saved on a tracked grant, the server finds it again
from the coins at that payee. That needs the verifier to list coins, which arrived in 0.2.3:

    cd verify && npm version patch && npm publish          # 0.2.2 -> 0.2.3
    cd deploy && npm install @warda_protocol/verify@^0.2.3 && npx vercel --prod

Until then "Find it now" says the verifier does not list coins yet. Nothing else breaks.

## 6. Billing (Stripe)

Free beta until you switch it on. Stripe's own pages take the card; this site only ever sees ids.

1. Stripe → Products: **Warda Pro** at $29/month and **Warda Team** at $199/month. Copy each price id (`price_…`).
2. Stripe → Developers → Webhooks → Add endpoint:
   `https://www.wardaprotocol.com/api/account?op=stripe`, events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy its signing secret (`whsec_…`).
3. Stripe → Settings → Billing → Customer portal: turn it on (cancel, switch plan, invoices).
4. From `site/`, add each as Production, Sensitive:

       npx vercel env add STRIPE_SECRET_KEY production      # sk_live_… (sk_test_… to try it first)
       npx vercel env add STRIPE_WEBHOOK_SECRET production  # whsec_…
       npx vercel env add STRIPE_PRICE_PRO production       # price_…
       npx vercel env add STRIPE_PRICE_TEAM production      # price_…

5. Deploy. Your account now shows Choose Pro / Choose Team; accounts stay on the Beta plan until they choose.
6. If Stripe's test event says "signature does not match", Vercel parsed the body first: add
   `NODEJS_HELPERS=0` and deploy again.

To end the beta: `BILLING_ENFORCED=1`. Syncing grants, server alerts, following and history then need Pro or
Team; everything in the browser stays free. The beta ends for everyone at that moment: beta accounts are
treated as free until they choose a plan, so tell beta users before you set it.
