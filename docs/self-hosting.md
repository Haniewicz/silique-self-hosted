# Self-hosting Silique Server

Silique Server is a single-user synchronization server for your encrypted notes.
You run it on your own Linux host, behind TLS, and connect the Silique app from
any number of your devices. This guide takes you from a fresh server to a
running, backed-up, and restorable installation. To get the client, see the
[Download the app](../README.md#download-the-app) section of the README.

There are two ways to install:

- **[Quick install](#quick-install)** — a single command (`infra/install.sh`) that
  provisions Node 24, the code, the `silique` user, directories, systemd units and
  backups for you.
- **[Manual install](#installation)** — the step-by-step path below, for people who
  want to see and control every file and command. The installer does exactly these
  steps, minus the mistakes this guide once had.

> **Single-user by design.** There is exactly **one account**. The first account
> is created from the app the first time it connects (see
> [First application launch](#first-application-launch)); immediately after,
> registration is permanently closed and every further attempt returns `403`.
> There is no invite system, no admin dashboard, and no multi-tenant mode.

---

## Quick install

`infra/install.sh` installs everything into the same well-known locations the
manual guide uses (`/opt/silique`, `/etc/silique/server.env`, `/var/lib/silique`,
`/var/backups/silique`), creates the `silique` system user, downloads and verifies
Node 24 to `/opt/silique-node`, builds the current release, renders the systemd
units with the correct paths, and immediately verifies that the service is
`active`, `/health` answers `{"status":"ok","protocol":1}` and the first backup
passes `PRAGMA quick_check`.

```sh
# Grab the repository and run the installer as root.
git clone https://github.com/Haniewicz/silique-self-hosted.git
cd silique-self-hosted
sudo ./infra/install.sh install
```

With a domain and automatic HTTPS (Caddy):

```sh
sudo ./infra/install.sh install --domain notes.example.com --tls caddy
```

The server stays on `127.0.0.1:8787` unless you pass `--tls`. Create your account
from the Silique app afterwards, then manage the server with:

```sh
sudo ./infra/install.sh status
sudo ./infra/install.sh backup-now
sudo ./infra/install.sh upgrade <version>
```

> `./infra/install.sh help` lists every subcommand and flag, including
> `--self-signed`, `--no-backup-timer`, `--node-bin <path>` (use your own Node) and
> `--dry-run`. Prefer the [manual path](#installation) if you want to audit each
> step yourself.

---

## Table of contents

1. [Quick install](#quick-install)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Running as a systemd service](#running-as-a-systemd-service)
6. [Reverse proxy and TLS](#reverse-proxy-and-tls)
7. [First application launch](#first-application-launch)
8. [Adding more devices](#adding-more-devices)
9. [Updating the server](#updating-the-server)
10. [Backups](#backups)
11. [Restoring a backup](#restoring-a-backup)
12. [Troubleshooting](#troubleshooting)

---

## Requirements

- **Linux** (a bare server or a VPS; tested on Debian 13 and Ubuntu).
- **Node.js >= 24**. SQLite is provided by the built-in `node:sqlite` module, so
  **no separate SQLite package or system library is required** (the `sqlite3` CLI
  is optional — see [Backups](#backups)).
- **~1 GB RAM** is enough for a single user. The server keeps everything in
  SQLite and is idle most of the time.
- **One TCP port** of your choice (the default used throughout this guide is
  `8787`) reachable from the reverse proxy on the same host.
- A **domain name** (or a public IP) for TLS, plus outbound access to a
  certificate authority if you use Caddy or a webroot ACME client. A LAN-only or
  self-signed setup without a domain is covered in
  [Reverse proxy and TLS](#reverse-proxy-and-tls).

### Packages on a fresh Debian 13

A minimal Debian 13 image does not ship `curl`, `git`, `gnupg` or
`ca-certificates`. Install them before you begin:

| Package           | Why                                          |
| ----------------- | -------------------------------------------- |
| `curl`            | download the Node.js tarball and checksums   |
| `ca-certificates` | trust the nodejs.org TLS certificate         |
| `git`             | clone the server release                     |
| `gnupg`           | verify keys for third-party/apt use          |

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates git gnupg
```

(The installer `infra/install.sh` installs these automatically via
`apt-get install -y` when it detects they are missing. When you pass
`--tls nginx` or `--tls caddy` it also installs the matching proxy package,
`nginx` or `caddy`, before writing any proxy configuration.)

### Node.js 24

The systemd units launch Node from **`/opt/silique-node/bin/node`**. Install the
official Node 24 there — the same way the installer does — so the units work
unchanged:

```sh
# Determine the architecture: x64 or arm64.
ARCH=x64   # use arm64 on aarch64 machines
cd /tmp
curl -fsSLo SHASUMS256.txt "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"
# Pick the actual node-v24.x.y-linux-<arch>.tar.xz shipped under latest-v24.x.
TARBALL=$(awk '{print $2}' SHASUMS256.txt \
  | grep -E "^node-v24\.[0-9]+\.[0-9]+-linux-${ARCH}\.tar\.xz$" | head -1)
curl -fsSLo "$TARBALL" "https://nodejs.org/dist/latest-v24.x/$TARBALL"
grep "  ${TARBALL}$" SHASUMS256.txt | sha256sum -c -
sudo mkdir -p /opt/silique-node
sudo tar -xJf "$TARBALL" -C /opt/silique-node --strip-components=1
/opt/silique-node/bin/node -v   # must print v24.x
```

If you already have Node 24 somewhere else, point the units at it instead (see
[Running as a systemd service](#running-as-a-systemd-service), or pass
`--node-bin <path>` to the installer).

---

## Installation

We install into three well-known locations:

| Path                  | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `/opt/silique/current`| The code (a symlink to a release directory)    |
| `/var/lib/silique`    | The SQLite database (private, mode `0700`)      |
| `/etc/silique/server.env` | Environment configuration               |

### 0. Node 24

Follow [Node.js 24](#nodejs-24) above first. The remaining steps assume
`/opt/silique-node/bin/node` exists. The tarball is unpacked into
`/opt/silique-node/bin`, which is **not** on your `PATH` and does not install
into `/usr/bin` — so add it to your `PATH` before you call `node`/`npm`:

```sh
export PATH=/opt/silique-node/bin:$PATH
```

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

Create the **backups directory now** too, with the same ownership and mode, so
the backup timer (which runs as `User=silique`) can write on its first nightly
run instead of failing with `unable to open database file`:

```sh
sudo install -d -o silique -g silique -m 0700 /var/backups/silique
```

### 3. Install the code

The server ships a `dist/` build compiled from TypeScript, so **`dist/` is already
in the checkout** — you still run `npm run build` once to be safe, but a
first-time release only needs `npm ci`. The release directory is named after the
version reported by `package.json`, and the `silique` user must own **the release
directory itself** — never the `current` symlink, which resolves to whatever it
currently points at:

```sh
sudo mkdir -p /opt/silique/releases
sudo chown root:root /opt/silique/releases
# as root (the build writes into the checkout):
cd /opt/silique/releases
# Clone the default branch — no tag is required, releases may not be tagged:
sudo git clone --depth 1 \
  https://github.com/Haniewicz/silique-self-hosted.git silique-src
# Read the version from package.json INSIDE the checkout (the only
# authoritative source) -- running this from /opt/silique/releases would look
# for a package.json that is not there:
cd silique-src
VERSION_REAL=$(node -p "require('./package.json').version")
cd ..
sudo mv silique-src "silique-$VERSION_REAL"
cd "silique-$VERSION_REAL"
npm ci
npm run build
# Own the release directory itself — NOT the symlink.
sudo chown -R silique:silique "/opt/silique/releases/silique-$VERSION_REAL"
sudo ln -sfn "/opt/silique/releases/silique-$VERSION_REAL" /opt/silique/current
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

### Creating the account from the CLI / CI (fallback only)

`README.md` documents an alternate way to create the account:

```sh
SILIQUE_INITIAL_PASSWORD='at-least-12-characters' npm run admin -- create-user user@example.com
```

Treat this as a **fallback / CI bootstrap path only**. It creates the account
row, but **it does not set up the account key envelope** — the created account
has `accountEnvelope: null`, which means there is **no Account Master Key
envelope and no recovery key**. Every paired device is bootstrapped from the
encryption keys the *app* establishes during registration or login; an account
created this way cannot be paired or recovered normally. Prefer first-account
creation from the app, and use `admin create-user` only where you must seed a
throwaway/CI account and understand the key-envelope limitation.

---

## Running as a systemd service

> The files under `infra/systemd/*.service` are **templates** for `install.sh`
> (they contain `@NODE@`, `@WORKDIR@`, `@CONFIG@`, `@DATA_DIR@` and `@BACKUPS_DIR@`
> placeholders that the installer substitutes). **Do not copy them verbatim** —
> systemd cannot run a unit whose `ExecStart` contains a literal `@NODE@` and the
> service will fail with `status=203/EXEC`. Paste the ready units below instead;
> they are exactly what `install.sh` renders for the default paths.

Create `/etc/systemd/system/silique.service` with this content:

```ini
[Unit]
Description=Silique encrypted synchronization API
After=network.target

[Service]
Type=simple
User=silique
Group=silique
WorkingDirectory=/opt/silique/current
EnvironmentFile=/etc/silique/server.env
ExecStart=/opt/silique-node/bin/node /opt/silique/current/dist/src/index.js
Restart=on-failure
RestartSec=3
UMask=0077
StateDirectory=silique
StateDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/var/lib/silique

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```sh
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

> If your Node.js is installed elsewhere, change the `ExecStart` path in
> `/etc/systemd/system/silique.service` to your `node` binary (confirm with
> `command -v node`), then `sudo systemctl daemon-reload && sudo systemctl
> restart silique`. The installer (`infra/install.sh`) renders this path for you
> from `--node-bin`.

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

Caddy manages certificates automatically. Install it first
([Caddy install docs](https://caddyserver.com/docs/install), or from your
distribution's packages with `sudo apt-get install -y caddy`), then write three
lines:

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

Install nginx first:

```sh
sudo apt-get install -y nginx
```

Then write your site configuration (substituting your own domain and
certificate paths):

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

Enable the site and reload nginx:

```sh
sudo ln -s /etc/nginx/sites-available/silique /etc/nginx/sites-enabled/silique
sudo nginx -t && sudo systemctl reload nginx
```

> The server sets `trustProxy:false`, so it ignores `X-Forwarded-*`; the
> `proxy_set_header` lines above are for correct logging and routing, not for
> auth. Because auth is a bearer header over the origin of the request, the
> proxy must simply forward the request untouched and terminate TLS itself.

### Option C — LAN / self-signed (no domain)

On a home LAN you may not have a domain. In that case terminate TLS with a
**self-signed certificate whose SAN covers the server's IP address**, and point
the app at `https://<IP>`. The app must trust the certificate (import the cert
into the OS trust store, or accept it once) — a self-signed cert is still
encryption, just without a public-CA-verified identity.

Generate it:

```sh
sudo mkdir -p /etc/nginx/silique
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout /etc/nginx/silique/key.pem \
  -out   /etc/nginx/silique/cert.pem \
  -subj "/CN=192.168.1.20" \
  -addext "subjectAltName=IP:192.168.1.20"
```

Swap the certificate paths in the nginx config above for the self-signed pair,
keep `server_name` as the IP, and reload nginx. (The installer does this with
`--tls nginx --self-signed --domain 192.168.1.20`.) Because the cert is not from
a public CA, each client device must be told to trust it before the Silique app
can connect.

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
instantly. No git tag is required: clone the default branch and name the new
release directory from the version in `package.json` — exactly as in
[Installation](#installation):

```sh
export PATH=/opt/silique-node/bin:$PATH
cd /opt/silique/releases
sudo git clone --depth 1 \
  https://github.com/Haniewicz/silique-self-hosted.git silique-src
# The release directory is named from package.json, not a tag -- read it from
# inside the fresh checkout:
cd silique-src
VERSION_REAL=$(node -p "require('./package.json').version")
cd ..
sudo mv silique-src "silique-$VERSION_REAL"
cd "silique-$VERSION_REAL"
npm ci
# dist/ is already in the repo; rebuild only to pick up any changes you made.
npm run build
# Own the RELEASE DIRECTORY, not the symlink. Using `chown` on /opt/silique/current
# would dereference the symlink and re-own the previous release, while the new
# directory stays root:root.
sudo chown -R silique:silique "/opt/silique/releases/silique-$VERSION_REAL"
sudo ln -sfn "/opt/silique/releases/silique-$VERSION_REAL" /opt/silique/current
sudo systemctl restart silique
sudo systemctl status silique
curl -s http://127.0.0.1:8787/health
```

Because `current` is a symlink to the versioned directory, a bad release is one
symlink flip away:

```sh
sudo ln -sfn /opt/silique/releases/silique-<previous-version> /opt/silique/current
sudo systemctl restart silique
```

> The installer does all of this — including a pre-upgrade backup and an
> automatic rollback if the new release fails to start — with
> `sudo ./infra/install.sh upgrade <version>` (which also needs no tag).

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
`/var/backups/silique/silique-2025-11-08T03-20-00.000Z.sqlite`. The file is
written with mode **`0600`** (the unit sets `UMask=0077`), readable only by the
`silique` user.

### Automate with a systemd timer

The repository includes a oneshot service and a timer under `infra/systemd/`.
As noted in [Running as a systemd service](#running-as-a-systemd-service), the
`.service` files there are templates — paste these ready units instead (exactly
what `install.sh` renders for the default paths).

Create `/etc/systemd/system/silique-backup.service`:

```ini
[Unit]
Description=Consistent online backup of Silique
After=silique.service
[Service]
Type=oneshot
User=silique
Group=silique
UMask=0077
EnvironmentFile=/etc/silique/server.env
ExecStart=/opt/silique-node/bin/node /opt/silique/current/infra/backup/backup.mjs /var/backups/silique
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/silique /var/backups/silique

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/silique-backup.timer`:

```ini
[Unit]
Description=Daily Silique backup
[Timer]
OnCalendar=*-*-* 03:20:00 Europe/Warsaw
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
```

Then enable the timer:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now silique-backup.timer
sudo systemctl list-timers silique-backup.timer
```

The timer runs daily at 03:20 (with a 10-minute random delay). Edit the timer's
`OnCalendar=` to taste.

**Run the backup once by hand now** to confirm it works — otherwise a permission
problem in the destination directory only surfaces on the first night, when
nobody is watching:

```sh
sudo systemctl start silique-backup.service
sudo systemctl status silique-backup.service   # must say: active (exited) / SUCCESS
sudo ls -l /var/backups/silique/
```

The unit runs as `User=silique`, so `/var/backups/silique` must already exist and
be owned by `silique` (see step 2 in [Installation](#installation)). If it is
`root:root`, the backup fails with `ERR_SQLITE_ERROR errcode 14` (`unable to open
database file`) even when a manual run as root succeeds.

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

If you do not have the `sqlite3` CLI, the DB is SQLite and the built-in
`node:sqlite` module can open it without any external package:

```sh
node --input-type=module -e \
  "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('PRAGMA quick_check').get());d.close();" \
  /var/backups/silique/silique-<timestamp>.sqlite
```

(`npm` users can also install the CLI with `sudo apt-get install -y sqlite3`.
The server itself never needs the CLI.)

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

### `status=203/EXEC` and a 3-second restart loop

Both units fail with `status=203/EXEC` when systemd cannot execute the binary in
`ExecStart`. This is almost always a **wrong `ExecStart` path** — for example a
`ExecStart=/opt/silique-node/bin/node` that points at a directory that was never
created. Fix the path to the real `node` binary (see
[Node.js 24](#nodejs-24)), run `sudo systemctl daemon-reload`, then
`sudo systemctl restart silique` (and `silique-backup.service`).

### `ERR_SQLITE_ERROR` / `unable to open database file` (errcode 14) in the backup

The backup unit runs as `User=silique`. If the destination directory
`/var/backups/silique` does not exist or is not owned by `silique`, the backup
fails the moment it tries to create the database there — a manual run as root
works and **masks** the problem until the first nightly run. Create and own it:

```sh
sudo install -d -o silique -g silique -m 0700 /var/backups/silique
sudo systemctl start silique-backup.service
sudo systemctl status silique-backup.service
```

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
the usual cause. For a self-signed LAN setup, make sure the cert's SAN includes
the server IP and that the client device trusts the cert (see
[Option C](#option-c--lan--self-signed-no-domain)).

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
