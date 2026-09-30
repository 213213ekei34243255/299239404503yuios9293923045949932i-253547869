# Jonah licence server and Developer Console

> **Which server is this?** This folder is the original, dependency-free **Node reference implementation** (used for development, for the tests,
> and by `Noah/bench/integration/license-gate-check.cjs`). The **production** licence server is the same thing ported into the jonahbrowser.store
> FastAPI backend (its `app/license/` module and `/admin/` console): identical API, database schema, password hashes and tokens, so the Mac app
> cannot tell them apart. Its setup guide is the "Developer access" section of that project's README.

Controls who may use the **Mac app's developer-access (unlimited) mode**.

```
Mac app  ──HTTPS──▶  this server (/v1)  ──▶  SQLite (accounts, devices, sessions, audit)
                          ▲
Developer Console (/admin) ┘   you manage everything here, from any browser
```

The server is the only place any decision is made. The Mac app holds no credentials and no "authorized" flag; it holds a token the
server signed (3 minutes), and asks the server again every minute.

## What it does

| You want | Where |
|---|---|
| Turn the whole Mac app on/off | Console → **Mac app access** switch |
| Turn unlimited-access mode on/off | Console → **Unlimited-access mode** switch |
| Ban / unban an account | Console → account row → **Ban** / **Unban** |
| Disable / enable an account (reversible) | **Disable** / **Enable** |
| Create, edit, delete accounts; change a password | **Create account**, **Edit**, **Delete**, **Password** |
| See active / disabled / banned / expired, and who is online | The chips at the top and the **Status** / **Online** columns |
| See the device an account is bound to; free it for another Mac | **Authorized device** column, **Revoke device** |
| Force a re-login / end a session now | **Sign out now** |
| Give an account an end date | **Edit** → expiry |
| See what happened | **Audit log** tab |

Banned, disabled, expired accounts, and a switched-off app or mode, all show the user:
*"Sorry, your developer access mode has expired. Kindly reinstall the app from the Mac App Store or jonahbrowser.com, or please contact Customer Care Service."*
A second Mac using an already-bound account sees the separate *"This account is already authorized on another device…"* message.

**How fast is "immediately"?** A running app asks the server every 60 seconds, so a ban, revoke or deactivation locks it within about
a minute. Backends that verify the token themselves (see below) stop honouring an already-issued token within its 3-minute lifetime.

## Run it locally

Needs Node 22.5 or newer (uses the built-in `node:sqlite`). No `npm install`: there are no dependencies.

```
cd license-server
ADMIN_USERNAME=owner ADMIN_PASSWORD='a-long-password-here' node server.cjs
```

Open http://127.0.0.1:8080/admin/. Without `ADMIN_PASSWORD` a random one is generated and printed once on first start.
Everything is stored in `license-server/data/` (git-ignored): `license.db` and `signing-key.pem` (the private key: back it up, never share it).

## Put it online (required before real users)

1. **Host it somewhere with HTTPS and a persistent disk.** Render, Fly.io or a small VPS all work. A host whose disk is wiped on every
   deploy (e.g. Render's free web service) would lose every account, so use a disk/volume, and point `DATA_DIR` at it.
2. Set `NODE_ENV=production` (this turns on "HTTPS required"), `TRUST_PROXY_HOPS=1` when a proxy such as Render/Cloudflare terminates TLS,
   and `ADMIN_USERNAME` / `ADMIN_PASSWORD` (12+ characters).
3. Run **one** instance only (one SQLite file).
4. Put your accounts in through the console (**Create account**), or on first start with `SEED_ACCOUNTS='[{"username":"…","password":"…"}]'`
   (then delete that variable: it is only used for accounts that do not exist yet, and it holds plaintext passwords).
5. Start it, read the log line `public key (for the Mac app's build settings)`, or run `node cli.cjs keygen`.
6. Tell the Mac build where the server is (next section).

Harden the console: it is an internet-facing page that controls everyone's access. Set `ADMIN_ALLOWED_IPS=your.ip` to only serve it to you, or put
it behind Cloudflare Access / a VPN, or switch it off (`ADMIN_ENABLED=0`) and use `cli.cjs` instead. Sign-in already locks after repeated
failures, uses HttpOnly SameSite=Strict cookies, CSRF tokens, and a strict content-security-policy.

### Environment variables

`PORT` (8080) · `HOST` · `DATA_DIR` · `NODE_ENV=production` · `REQUIRE_HTTPS` · `TRUST_PROXY_HOPS` · `LICENSE_SIGNING_KEY` (a PEM, or its base64, to keep
the key in the host's secret store instead of a file) · `TOKEN_TTL_SECONDS` (180) · `SESSION_IDLE_SECONDS` (900) · `ADMIN_USERNAME` ·
`ADMIN_PASSWORD` · `ADMIN_ALLOWED_IPS` · `ADMIN_ENABLED` · `SEED_ACCOUNTS` · `TLS_CERT_FILE` / `TLS_KEY_FILE` (to serve HTTPS directly)

## Point the Mac app at it

The Mac app needs two non-secret values, compiled into the signed app (a packaged app ignores the environment):
the server's `https://` address and its **public** key (`kid` + `spki` from `keygen`). The Mac workflow writes them from repository secrets
`LICENSE_SERVER_URL`, `LICENSE_KEY_ID`, `LICENSE_PUBLIC_KEY` into `license-config.generated.json`. Without them the Mac app shows
"not set up" and will not start, by design (it fails closed).

Development on another OS: `JONAH_REQUIRE_LICENSE=1 JONAH_LICENSE_URL=http://127.0.0.1:8080 JONAH_LICENSE_KEYS='[{"kid":"…","spki":"…"}]' npm start`.

## Recovery

`node cli.cjs reset-admin <username>` (on the server) creates or resets a console administrator; `cli.cjs list | add-account | set-password` manage accounts.

## What this can and cannot stop (please read)

It is built on one principle: **a determined person controls their own Mac and can patch the app, so the app is never the guard.**

* Stopped: guessing/sharing an account (one device per account, proven with a key that lives in the macOS Keychain and a hardware id, not a file
  that can be copied); editing local files, settings or flags (there are none to edit); reusing an old or copied session (tokens live 3 minutes,
  are bound to the device and to each request, and every renewal is checked with the server); using a revoked/banned account; brute force (lock-outs
  per user+IP, per user and per IP); a fake server (replies are verified against the pinned public key).
* **Not stopped by this alone:** someone who patches the app so it *skips* the sign-in screen. The app then simply has no token. That only matters if
  the valuable things (the hosted AI at noahai.live, the voice service, the search service) **check the token themselves**. They must verify the
  Ed25519 signature with the public key (`GET /v1/public-keys`), the audience `jonah-mac`, and `exp`. Until they do, a patched app still gets through
  to them. Keep that in mind before promising "unlimited only for logged-in users".
* Passwords chosen by you are only as strong as you make them; the server throttles guessing but cannot make a short, guessable password strong.

## Tests

`npm test` (53 tests: rules, HTTP, console API, and the Mac app's client against this real server). The whole flow with the real Jonah app is
`node Noah/bench/integration/license-gate-check.cjs` from the repository root.
