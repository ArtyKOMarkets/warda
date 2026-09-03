# A node that outlives a terminal

The quick tunnel this project has been using (`cloudflared tunnel --url …`)
gets a new random hostname every run and dies with the terminal that started
it. That is why the demo page went stale, why the CLI quickstart could not be
followed by anyone else, and why the interop tests still have not touched a
chain.

A *named* tunnel fixes the hostname. It does not fix the laptop: both services
below are LaunchAgents, so they run while you are logged in and stop when the
machine sleeps. That is the honest limit of hosting this here rather than on a
small VPS, and it is fine for demos and development. It is not fine for
anything that claims to be always-on.

## The short path: Tailscale Funnel

Free on every plan, needs no domain, and the hostname is stable across
restarts. It is what unblocks the work today. It does not make anything
always-on — see the note above about laptops — but it gets a real, public,
stable `wss://` endpoint in about ten minutes.

**1. Install Tailscale and sign in.**

Download the `.pkg` from <https://pkgs.tailscale.com/stable/> (the macOS
installer; the `.zip` is the same app without the installer), run it, and sign
in. Signing in creates your tailnet and names this machine.

The CLI lives inside the app bundle rather than on PATH:

    /Applications/Tailscale.app/Contents/MacOS/Tailscale status

That path is used in full below. If a plain `tailscale` works for you, use that
instead.

**2. Start the node first**, in its own Terminal window, so there is something
to funnel:

    ~/Desktop/warda/ops/run-node.sh

**3. Funnel the JSON RPC port.**

    sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 18210

`--bg` stores the configuration rather than holding the terminal, and
tailscaled re-applies it when it starts — so unlike a foreground tunnel this
survives a reboot without a LaunchAgent of its own.

The first run may refuse and print a link: Funnel needs HTTPS certificates and
the Funnel node attribute enabled for the tailnet. Follow the link, enable it,
run the command again.

It prints the public URL, which looks like
`https://artautass-macbook-pro-2.tailXXXX.ts.net`. Note it down — with `wss://`
in place of `https://`, that is the node's address.

**4. Check it from outside.**

    cd ~/Desktop/warda/sdk
    node --experimental-strip-types tools/check-node.ts --rpc wss://YOUR-NAME.tailXXXX.ts.net

This does not just connect — it asks whether the node is worth believing:
synced, utxo-indexed, on the network it claims. All four checks should pass.

Funnel is documented as an HTTPS proxy and Tailscale does not state anywhere
whether it carries a WebSocket upgrade. It should, and this command is how we
find out; if it does not, that is the point to fall back to a rented box.

**5. Keep the node up across a reboot.**

Funnel already persists. kaspad does not, so it gets a LaunchAgent:

    cp ~/Desktop/warda/ops/com.wardaprotocol.kaspad.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.wardaprotocol.kaspad.plist

Then run step 4 again.

## The other path: a named Cloudflare tunnel

### What you need first

A domain in a Cloudflare account. Named tunnels route through Cloudflare DNS,
so the zone has to be there — if `wardaprotocol.com` is on Vercel's
nameservers, either move the zone to Cloudflare or use a different domain you
already have there. `cloudflared tunnel login` lists what is available, so run
that first and see.

### Steps

Run each of these in Terminal, one at a time.

**1. Install cloudflared.**

It is a single static binary, so this needs neither Homebrew nor sudo. For
Apple Silicon:

    mkdir -p ~/.local/bin
    curl -L -o /tmp/cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
    tar xzf /tmp/cloudflared.tgz -C ~/.local/bin
    chmod +x ~/.local/bin/cloudflared
    ~/.local/bin/cloudflared --version

(On an Intel Mac the asset is `cloudflared-darwin-amd64.tgz`.)

`~/.local/bin` is probably not on your PATH, and the steps below all use the
full path so it does not need to be. To type `cloudflared` instead, append
this one line to `~/.zshrc` — note the `>>`, which adds to the file, and that
the line keeps the existing PATH rather than replacing it:

    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc

Then open a new Terminal tab and check `echo $PATH` still looks right.

**2. Log in and pick the zone.**

    ~/.local/bin/cloudflared tunnel login

A browser opens and lists the domains in your Cloudflare account. Choosing one
writes a certificate to `~/.cloudflared/cert.pem`. If the list is empty or does
not contain the domain you want, stop here — the rest cannot work yet.

**3. Create the tunnel.**

    ~/.local/bin/cloudflared tunnel create warda-node

This prints a UUID and writes `~/.cloudflared/<UUID>.json`. Keep both; the
config file needs them.

**4. Point a hostname at it.**

    ~/.local/bin/cloudflared tunnel route dns warda-node node.example.com

Use a subdomain of the zone you chose in step 2.

**5. Write the config.**

Copy `cloudflared-config.yml` from this folder to `~/.cloudflared/config.yml`
and replace the three placeholders with the UUID from step 3 and the hostname
from step 4.

    cp ~/Desktop/warda/ops/cloudflared-config.yml ~/.cloudflared/config.yml

Then edit that file.

**6. Start the node, in the foreground, once.**

    ~/Desktop/warda/ops/run-node.sh

Watch it come up and stay up. If kaspad is not found, the script says where it
looked — set `KASPAD` to the real path and try again. Leave it running for the
next step.

**7. In a second Terminal window, start the tunnel once.**

    ~/.local/bin/cloudflared tunnel run warda-node

**8. Check it from outside.**

    cd ~/Desktop/warda/sdk
    node --experimental-strip-types tools/check-node.ts --rpc wss://node.example.com

This is the real test: it connects, then asks whether the node is worth
believing — synced, utxo-indexed, on the network it claims. All four checks
should pass.

**9. Make both survive a reboot.**

Once step 8 passes, stop both foreground processes (Ctrl-C in each) and install
them as LaunchAgents:

    cp ~/Desktop/warda/ops/com.wardaprotocol.kaspad.plist ~/Library/LaunchAgents/
    cp ~/Desktop/warda/ops/com.wardaprotocol.tunnel.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.wardaprotocol.kaspad.plist
    launchctl load ~/Library/LaunchAgents/com.wardaprotocol.tunnel.plist

The tunnel plist points at `~/.local/bin/cloudflared`. If you installed it
somewhere else, or named the tunnel something other than `warda-node`, edit the
plist before copying it — launchd does not read your shell profile, so the path
in there has to be absolute and correct.

Then run step 8 again. If it still passes, the node has a permanent address.

## Taking a reading every hour

Agent #001 wants a reading on a schedule; a daily digest is then whichever two
of them sit closest to 24 hours apart. Each run is independent — it reads no
previous file and writes no state — so a missed hour costs one data point and
leaves nothing to repair.

`hourly-reading.sh` exists because cron runs with a nearly empty PATH and does
not read your shell profile. Everything it needs is named in the script,
absolutely. A cron entry that leans on the interactive shell's environment
works perfectly when tested by hand and then silently does nothing at 3am.

Check it runs on its own terms first:

    env -i HOME="$HOME" ~/Desktop/warda/ops/hourly-reading.sh

`env -i` strips the environment, which is roughly what cron gives it. If that
writes a reading, cron will too.

Then install the schedule. This is a script rather than a line to paste,
because a crontab line and a shell command are indistinguishable in a chat
window and pasting one where the other belongs fails silently — the trailing
`>> log 2>&1` swallows the shell's complaint:

    ~/Desktop/warda/ops/install-cron.sh

It keeps whatever is already in your crontab, replaces any previous entry for
this script rather than duplicating it, and prints the result.

Check after the next :17 past the hour:

    tail ~/Library/Logs/warda-agent.log
    ls ~/Desktop/warda/agent/readings/

macOS note: cron needs Full Disk Access to write inside `~/Desktop`. If the log
shows "Operation not permitted", grant it to `/usr/sbin/cron` in System
Settings > Privacy & Security > Full Disk Access.

## Afterwards

    launchctl list | grep wardaprotocol          # are they running
    tail -f ~/Library/Logs/warda-kaspad.log      # what the node is doing
    tail -f ~/Library/Logs/warda-tunnel.log      # what the tunnel is doing
    launchctl unload ~/Library/LaunchAgents/com.wardaprotocol.kaspad.plist

Set `WARDA_RESOLVER` or pass `--rpc wss://node.example.com` and everything in
this repository points at it: `site/refresh-demo.sh`, the CLI, the demo API,
and `agent/tools/read.ts`.
