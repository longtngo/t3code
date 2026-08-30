# Running T3 Code behind a reverse proxy

The server always listens over plain HTTP. It never terminates TLS itself, so when T3 Code is
reached over HTTPS something in front of it is doing that -- T3 Connect, Tailscale Serve, or a proxy
you run yourself.

## The one header that matters

The server decides whether a request arrived over HTTPS from `x-forwarded-proto`, and nothing else.
An origin-form request carries no scheme of its own, so there is no second signal to fall back on.

That answer sets the `Secure` flag on the browser session cookie. Get it wrong in the downward
direction and the cookie is issued without `Secure`, which means a browser will send it over plain
HTTP.

**Your proxy must overwrite `x-forwarded-proto`, not append to or forward the client's value.** A
client can send any header it likes; if that value survives to the server, a client can downgrade
its own session cookie.

- nginx: `proxy_set_header X-Forwarded-Proto $scheme;` (`proxy_set_header` replaces)
- Caddy: sets it correctly by default
- Traefik: sets it correctly by default
- Cloudflare / most managed load balancers: set it correctly by default

The server reads only the **first** hop of a comma-separated chain, which is the client-facing one.
Later hops may legitimately be `http`.

A spoofed `https` is harmless: the browser refuses a `Secure` cookie over plain HTTP, so the only
person affected is whoever sent the header. A spoofed `http` is the direction worth guarding, so a
positive HTTPS signal from the request URL wins over a forwarded `http`.

## Local and LAN use

`npx t3`, the dev server, and a direct LAN connection are plain HTTP by design, and the session
cookie is issued without `Secure` there. That is deliberate -- a `Secure` cookie over HTTP is
silently discarded by the browser, and login would be impossible.
