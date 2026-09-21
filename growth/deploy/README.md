# Researcher, hosted

Its own Vercel project, `warda-growth`, so it has its own origin — the signed
listing at `/.well-known/warda-service.json` must be served from the same host
as the endpoint it describes.

## Once

```
cd growth/deploy
npx vercel link                 # create the project "warda-growth"
npx vercel env add RESEARCHER_ADDRESS production    # kaspatest:… address of growth/keys/researcher.key
npx vercel env add GROWTH_QUOTE_SECRET production   # openssl rand -hex 32 — keep it; every instance must share it
npx vercel env add DATABASE_URL production          # the same Neon URL as the site's accounts; table growth_spent
npx vercel env add WARDA_RPC_JSON production        # optional: your node; without it a public node is found
npx vercel env add GITHUB_TOKEN production          # optional, no scopes: raises GitHub's rate limit
npx vercel --prod
```

Check it: `curl https://warda-growth.vercel.app/` describes it for free, and
`curl "https://warda-growth.vercel.app/verify?url=https://github.com/kaspanet/rusty-kaspa"`
answers 402 with a quote.

## If the URL is not warda-growth.vercel.app

The listing names its endpoint, so it must be re-signed for the real host:

```
# edit "endpoint" in growth/deploy/listing.json, then:
node --experimental-strip-types registry/tools/sign-listing.ts growth/deploy/listing.json \
  --key growth/keys/researcher.key > growth/deploy/public/.well-known/warda-service.json
```

and change the URL in `site/src/services.json` (service and `sources`), then
`node ops/build-registry-sources.mjs` and redeploy the registry.

## Editing what it sells

Edit `growth/src/service.ts` or `growth/src/verify-project.ts`, then
`node growth/deploy/sync.mjs`. CI fails if the copies in `lib/` differ.
