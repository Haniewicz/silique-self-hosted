# Self-hosting Silique Server

Silique Server is a single-user synchronization server for your encrypted notes.
You run it on your own Linux host, behind TLS, and connect the Silique app from
any number of your devices. This guide takes you from a fresh server to a
running, backed-up, and restorable installation.

> **Single-user by design.** There is exactly **one account**. The first account
> is created from the app the first time it connects (see
> [First application launch](#first-application-launch)); immediately after,
> registration is permanently closed and every further attempt returns `403`.
> There is no invite system, no admin dashboard, and no multi-tenant mode.

---

## Table of contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Running as a systemd service](#running-as-a-systemd-service)
5. [Reverse proxy and TLS](#reverse-proxy-and-tls)
6. [First application launch](#first-application-launch)
7. [Adding more devices](#adding-more-devices)
8. [Updating the server](#updating-the-server)
9. [Backups](#backups)
10. [Restoring a backup](#restoring-a-backup)
11. [Troubleshooting](#troubleshooting)

---

## Requirements

- **Linux** (a bare server or a VPS; tested on Debian and Ubuntu).
- **Node.js >= 24**. SQLite is provided by the built-in `node:sqlite` module, so
  **no separate SQLite package or system library is required**.
- **~1 GB RAM** is enough for a single user. The server keeps everything in
  SQLite and is idle most of the time.
- **One TCP port** of your choice (the default used throughout this guide is
  `8787`) reachable from the reverse proxy on the same host.
- A **domain name** (or a public IP) for TLS, plus outbound access to a
  certificate authority if you use Caddy or a webroot ACME client.

---

## Installation

We install into three well-known locations:

| Path                  | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `/opt/silique/current`| The code (a symlink to a release directory)    |
| `/var/lib/silique`    | The SQLite database (private, mode `0700`)      |
| `/etc/silique/server.env` | Environment configuration               |

### 1. Create the system user

Run everything as an unprivileged, dedicated user:

```sh
sudo useradd --system --home /var/lib/silique --shell /usr/sbin/nologin silique
```

### 2. Create the data directory (mode 0700)

The database directory must be readable and writable **only** by the `silique`
user, so that no other local account can read raw database bytes should a
backup-copy leak happen before encryption state is set up:

```sh
sudo mkdir -p /var/lib/silique
sudo chown silique:silique /var/lib/silique
sudo chmod 0700 /var/lib/silique
```

### 3. Install the code

The server ships a `dist/` build compiled from TypeScript, so we build it after
installing dependencies (never run `npm install` on a server — use `npm ci`) and
place the release under a versioned directory:

```sh
sudo mkdir -p /opt/silique/releases
sudo chown -R root:root /opt/silique/releases
# as root (the build writes into the checkout):
cd /opt/silique/releases
git clone https://github.com/Haniewicz/silique-self-hosted silique-0.2.45
cd silique-0.2.45
npm ci
npm run build
cd /opt/silique
sudo ln -sfn /opt/silique/releases/silique-0.2.45 current
sudo chown -R silique:silique /opt/silique/current
```

The running entrypoint is `dist/src/index.js` (that is the path the systemd unit
executes). `node_modules` must exist in the release directory because `npm ci`
installed the runtime dependencies of the built bundle there.

---

## Configuration

Copy the example environment file to its final location, then edit it:

```sh
sudo cp /opt/silique/current/infra/server.env.example /etc/silique/server.env
sudo chown root:silique /etc/silique/server.env
sudo chmod 0640 /etc/silique/server.env
sudo nano /etc/silique/server.env
```

The supported variables are exactly these:

```ini
HOST=127.0.0.1
PORT=8787
DATABASE_PATH=/var/lib/silique/silique.sqlite
CORS_ORIGINS=
```

| Variable         | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `HOST`           | Interface to bind. Keep `127.0.0.1`; the reverse proxy sits in front.        |
| `PORT`           | TCP port to listen on.                                                       |
| `DATABASE_PATH`  | Absolute path to the SQLite file (created automatically).                    |
| `CORS_ORIGINS`   | Comma-separated list of allowed web origins (used only by a future web UI).  |

> **`REGISTRATION_MODE` does not exist in this version.** If an environment
> variable of that name is present, the server logs a warning that it is ignored
> and continues in single-user mode. Do not try to set `REGISTRATION_MODE=open`
> (mailing-list style) or `REGISTRATION_MODE=invite` — neither exists. The
> server supports exactly one account, and that account is created from the app
> on first launch, not through a registration mode or an invite.

There is **no** initial password to pre-set: the account (email, password and an
encryption **recovery key**) is established interactively by the app the first
time it connects. See [First application launch](#first-application-launch).

---

## Running as a systemd service

A ready-made unit is included at `infra/systemd/silique.service`. Install it:

```sh
sudo cp /opt/silique/current/infra/systemd/silique.service /etc/systemd/system/silique.service
sudo systemctl daemon-reload
sudo systemctl enable --now silique
sudo systemctl status silique
```

The unit uses `StateDirectory=silique` (which creates `/var/lib/silique` with
mode `0700` if needed) and `UMask=0077`, and only permits writes inside
`/var/lib/silique`. It launches:

```
/opt/silique-node/bin/node /opt/silique/current/dist/src/index.js
```

> If your Node.js is installed elsewhere, adjust the `ExecStart` path to your
> `node` binary (confirm with `command -v node`).

Verify the server is up:

```sh
curl -s http://127.0.0.1:8787/health
```

Expected output:

```json
{"status":"ok","protocol":1}
```

Also confirm the discovery document:

```sh
curl -s http://127.0.0.1:8787/.well-known/silique
```

```json
{"name":"Silique","api_version":"1","registration":"first-user", ...}
```

The `registration:"first-user"` field is what the app reads to know that this
server accepts exactly one account via `/v1/auth/register`.

---

## Reverse proxy and TLS

**Use TLS. The session token is a long-lived bearer credential.** After login or
registration the app receives a 256-bit random token that authorizes device
sync for up to 30 days, and it is sent in the `Authorization` header on every
request. Serving the server over plaintext HTTP — anywhere except loopback on
your own host — lets any on-path network observer (café Wi-Fi, a compromised
router, hostile ISP) sniff that header and take over the account's sync session.
Scope access accordingly: the server itself binds to `127.0.0.1`, and only your
TLS-terminating reverse proxy exposes it to the network.

### Option A — Caddy

Caddy manages certificates automatically. Three lines:

```
notes.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

A fuller example ships in `infra/caddy/Caddyfile` (security headers included).
Enable it by pointing Caddy at your site configuration and reloading:

```sh
sudo systemctl reload caddy
```

### Option B — nginx

```nginx
server {
    listen 443 ssl;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 4m;
    }
}

# Redirect plaintext to TLS so no token ever travels in the clear.
server {
    listen 80;
    server_name notes.example.com;
    return 301 https://$host$request_uri;
}
```

> The server sets `trustProxy:false`, so it ignores `X-Forwarded-*`; the
> `proxy_set_header` lines above are for correct logging and routing, not for
> auth. Because auth is a bearer header over the origin of the request, the
> proxy must simply forward the request untouched and terminate TLS itself.

---

## First application launch

Everything is now ready. Open the Silique app and point it at your server:

1. In the app, enter the **server address**, e.g. `https://notes.example.com`.
2. Enter your **email** and a **password of at least 12 characters**.
3. Tap **Create account** / register.

The app performs `POST /v1/auth/register` and the server creates the account,
returning the session token. **Immediately write down the recovery key** the app
displays and store it somewhere safe and separate from the server (a password
manager, a paper copy). The recovery key is your only path back into the account
if you lose every paired device; the server stores nothing that can reproduce
it, and backups (below) do **not** contain it.

The server is now permanently closed to new accounts:

- A **second registration** (a different email) returns **`403`** with
  `{"error":"This is a single-user server: only one account is allowed"}`.
- This is expected, not a bug: it means your instance is locked to you. Logging
  in from your other devices uses login/pairing, **not** registration.

If you ever want to start over, stop the service, move the database aside (or
delete it — you lose the account), and let the app register a fresh first
account.

---

## Adding more devices

You can use the account from several devices. There are two ways, both handled
inside the app:

- **Pairing via security code** — the new device logs in (`POST /v1/auth/login`)
  and the two devices exchange X25519 public keys; you compare the full
  16-character security code on both screens, and the older device approves by
  sending the encrypted Account Master Key envelope.
- **Recovery key** — the recovery key you saved at registration restores the
  account onto a fresh device on its own.

The server never receives plaintext account keys: it only relays key envelopes
and pairing offers.

---

## Updating the server

Updates use a **new release directory + symlink flip**, so you can roll back
instantly:

```sh
cd /opt/silique/releases
git clone https://github.com/Haniewicz/silique-self-hosted silique-<new-version>
cd silique-<new-version>
npm ci
npm run build
cd /opt/silique
sudo ln -sfn /opt/silique/releases/silique-<new-version> current
sudo chown -R silique:silique /opt/silique/current
sudo systemctl restart silique
sudo systemctl status silique
curl -s http://127.0.0.1:8787/health
```

Because `current` is a symlink to the versioned directory, a bad release is one
symlink flip away:

```sh
sudo ln -sfn /opt/silique/releases/silique-<previous-version> current
sudo systemctl restart silique
```

---

## Backups

Back up with the included script, which uses SQLite's *online backup API* so the
WAL is captured consistently even while the service is running (never copy the
bare `.sqlite` file while it is live — that can produce a corrupt snapshot):

```sh
sudo cp -r /opt/silique/current/infra/backup /opt/silique/backup
```

The script takes the destination directory as its only argument:

```sh
DATABASE_PATH=/var/lib/silique/silique.sqlite node /opt/silique/current/infra/backup/backup.mjs /var/backups/silique
```

It writes a timestamped file such as
`/var/backups/silique/silique-2025-11-08T03-20-00.000Z.sqlite`, mode `0700`.

### Automate with a systemd timer

The repository includes a oneshot service and a timer:

```sh
sudo cp /opt/silique/current/infra/systemd/silique-backup.service /etc/systemd/system/
sudo cp /opt/silique/current/infra/systemd/silique-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now silique-backup.timer
sudo systemctl list-timers silique-backup.timer
```

The timer runs daily at 03:20 (with a 10-minute random delay). Edit the timer's
`OnCalendar=` to taste.

### Copy backups off the host

Backups on the same disk do not survive disk loss. Copy them elsewhere
regularly — for example:

```sh
rsync -a /var/backups/silique/ user@backup-host:/srv/silique-backups/
```

or to object storage by adding a small cron line. Rotate/retain as fits your
policy.

### Verify a backup (`quick_check`)

After each backup — and before relying on one — run SQLite's integrity check.
Here “restored path” is a copy restored into a scratch directory first, so you
never read the live database:

```sh
sqlite3 /var/backups/silique/silique-<timestamp>.sqlite 'PRAGMA quick_check;'
```

Expected output is a single line:

```
ok
```

(If you do not have the `sqlite3` CLI, use `node --input-type=module -e
"import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('PRAGMA quick_check').get());d.close();"
<file>` — the DB is SQLite and the built-in `node:sqlite` can open it without any
external package.)

---

## Restoring a backup

**Never restore over a live database.** Stop the service first so no process has
the SQLite file open, then replace the file(s) in place:

```sh
sudo systemctl stop silique
# Ensure any WAL/SHM sidecars are gone too.
sudo rm -f /var/lib/silique/silique.sqlite-wal /var/lib/silique/silique.sqlite-shm
sudo install -o silique -g silique -m 0600 \
  /var/backups/silique/silique-<timestamp>.sqlite \
  /var/lib/silique/silique.sqlite
sudo systemctl start silique
curl -s http://127.0.0.1:8787/health
```

Restore into a scratch directory first if you only want to inspect or verify
without touching production. Remember: the restore brings back the account and
encrypted data, but **not** the recovery key — that lives only with you.

---

## Troubleshooting

### `403` on registration ("account already exists")

The error body reads `single-user server: only one account is allowed`. It
means the first account already exists. This is by design. Log in
(`POST /v1/auth/login`) from your other devices instead of registering. If you
truly want a clean slate, stop the service, move the database aside, and let the
app register a new first account.

### `401` on requests ("Authentication required" / "Session expired")

Your session token is missing, expired (tokens last 30 days), or the device was
revoked. Log in again from the app. If a device was removed via
`DELETE /v1/devices/:id`, its sessions are revoked and it must be re-verified.

### TLS error / certificate failure in the app

Check that the reverse proxy terminates TLS correctly, the certificate covers
the exact hostname the app is configured with, and the app address begins with
`https://`. A mismatch between the host in the app and the certificate CN/SAN is
the usual cause.

### The app cannot reach the server

Work through these in order:

1. **Is anything listening locally?**
   `curl -s http://127.0.0.1:8787/health` — if nothing answers, check
   `sudo systemctl status silique` and `journalctl -u silique -n 100`.
2. **Is the proxy port forwarding correctly?** Confirm the proxy config points
   at the right `HOST:PORT` (default `127.0.0.1:8787`) and that a firewall, if
   any, allows the public TLS port (443).
3. **CORS / origin mismatch:** the client's origin must be listed in
   `CORS_ORIGINS` (comma-separated). The native app is not subject to CORS, but
   a future web UI is. Set the exact origin (no trailing slash) rather than `*`
   if possible.
4. **Check the logs** with `journalctl -u silique -f` while reproducing the
   request.

### "No space left on device"

Free space on the filesystem holding `/var/lib/silique` (and make sure
`/var/backups` is on a separate, sufficiently large disk). SQLite WAL files grow
with write activity; regular checkpoints and backups keep them bounded.

### Corrupted database (`SQLITE_CORRUPT` / failing `quick_check`)

Do **not** run recovery in place on the live file. Stop the service, restore the
latest verified backup into a scratch directory, run `PRAGMA quick_check` there
to confirm it is `ok`, and then follow
[Restoring a backup](#restoring-a-backup). If no backup is intact, treat the
loss as a data-loss incident and re-establish the account from the recovery key.
