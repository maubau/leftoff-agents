# Reaching the control panel away from home

The panel is served by the hub, and the hub must stay on the machine that holds your repositories: it reads
their files and git history and talks to Paseo on that machine. A web host has none of that, so the panel
cannot simply move there. What you can do is *reach* the one on your own machine safely, from a phone or any
computer.

## Recommended: Tailscale (private, free, nothing opened to the internet)

[Tailscale](https://tailscale.com) puts your devices on a private network, so your server stays invisible to
the rest of the internet.

1. Install Tailscale on the server and on the devices you will browse from, and sign in to the same account.
   On the server: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.
2. Make sure the panel has a password. Leftoff generates one the first time the hub starts; `leftoff web link`
   prints the address to open once.
3. Let Tailscale serve the panel over HTTPS: `sudo tailscale serve --bg 4777` (the exact subcommand varies with
   the Tailscale version; see `tailscale serve --help`). It prints an address like
   `https://my-server.<your-tailnet>.ts.net`.
4. Tell Leftoff that name is legitimate, in `~/.config/leftoff/config.yaml`:

   ```yaml
   web:
     allowedHosts: [my-server.<your-tailnet>.ts.net]
   ```

   Listing a name makes the password mandatory: behind a forwarder every request looks local, so the password
   is what protects the panel. The hub refuses to start the panel otherwise.
5. `systemctl --user restart leftoff-hub`, then open
   `https://my-server.<your-tailnet>.ts.net/?token=<the token>` once. The panel turns it into a cookie
   (`Secure` behind HTTPS) and removes the token from the address bar.

## Alternative: an SSH tunnel

`ssh -N -L 4777:127.0.0.1:4777 you@your-server`, then open `http://localhost:4777`. It needs the server to be
reachable by SSH (at home, or through Tailscale) and the tunnel to stay open while you use it.

## What not to do

Do not move the hub to a web host, and do not bind the panel to `0.0.0.0` on a public address. If you must
expose it through something else, keep Leftoff on your machine and only forward to it:

- **Cloudflare Tunnel** (`cloudflared`) from your machine to a hostname on a domain you own, with Cloudflare
  Access in front of it.
- **A small VPS** as a relay (`ssh -R` from your machine to the VPS, and a reverse proxy with HTTPS there).

Both work, but they put a public address in front of a panel that can talk to your agents. Tailscale gives the
same convenience without any of that exposure.
