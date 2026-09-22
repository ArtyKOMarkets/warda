# Warda Console (next)

The premium console: React 19 + TypeScript + Vite + Tailwind 4. Served at `/app-next/`
while the classic console at `/app` keeps working.

    npm install      # once
    npm run dev      # http://localhost:5173/app-next/ (readings load from the site's origin)
    npm run build    # → dist/, which site/build.py copies to web/app-next/

Data: published readings (`/agents.json`, `/agent-NNN.json`), the Services registry
(`/services.json`), and the hosted runner (`/v1/agents?detail=1`, `/v1/agents/:id/reading`)
with the same `warda.runner` sign-in the classic console uses.
