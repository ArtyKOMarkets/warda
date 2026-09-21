# /api — the console's server side

One function, `swap.mjs`, deployed with the site from `site/web/api/` (copied there by `site/build.py`,
with `_routes.json` and `_router.js` beside it — the same route table and address decoder the page uses).

It proxies ChangeNOW so the API key never reaches a browser. It holds no funds and stores nothing.

## Set up (once)

1. Create a ChangeNOW business (affiliate) account; the API key is under Profile details in its dashboard.
   If estimated-amount answers 401 with a valid key, ask partners@changenow.io to enable it for the key.
2. In the dashboard, set the partner commission to the lowest it allows. Warda's position is no fee;
   whatever the dashboard is set to, put the same number in `CHANGENOW_PARTNER_FEE_PCT` — the page shows it
   to the person on every quote, so it must be true.
3. Add both to the Vercel project that serves the site:

       npx vercel env add CHANGENOW_API_KEY production --cwd web
       npx vercel env add CHANGENOW_PARTNER_FEE_PCT production --cwd web

4. Deploy: `npx vercel --cwd web --prod`.

Without the key every call answers 503 `not_configured`, and the page says the swap service is not set up.

## Try it

    curl "https://www.wardaprotocol.com/api/swap?op=quote&chain=Base&token=USDC&amount=25"
