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
