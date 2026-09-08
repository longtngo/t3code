# Running T3 Code behind a reverse proxy

The server always listens over plain HTTP. It never terminates TLS itself, so when T3 Code is
reached over HTTPS something in front of it is doing that -- T3 Connect, Tailscale Serve, or a proxy
you run yourself.

## The header that decides HTTPS

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

## The header that names the device

Settings - Connections lists each signed-in device with the address it connected from. Behind a
proxy the socket only ever shows the proxy, so without `x-forwarded-for` every remote device is
listed as local and the screen cannot tell you about a device you did not expect.

Set `x-forwarded-for` to the client address, and overwrite rather than append:

- nginx: `proxy_set_header X-Forwarded-For $remote_addr;`
- Caddy, Traefik, Cloudflare and most managed load balancers: set it correctly by default

The server reads the **left-most** entry, which is the original client; later entries are
intermediate proxies. It honours the header only when the connection itself came from loopback,
which is the case for a proxy on the same machine. A request that arrives from a remote address
directly is recorded by its socket address and its `x-forwarded-for` is ignored, so a client
reaching the server without a proxy cannot choose what this screen says about it.

If your proxy is **not** on the same machine as the server, the address recorded is the proxy's, and
setting `x-forwarded-for` will not change that.

## Local and LAN use

`npx t3`, the dev server, and a direct LAN connection are plain HTTP by design, and the session
cookie is issued without `Secure` there. That is deliberate -- a `Secure` cookie over HTTP is
silently discarded by the browser, and login would be impossible.
