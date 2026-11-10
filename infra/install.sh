#!/usr/bin/env bash
# Silique self-hosted installer/upgrader/backup utility.
#
# Manages a single-user Silique server on a clean Debian/Ubuntu host under
# systemd. It fixes all of the known install-time failures of the manual guide:
# a real Node 24 binary at /opt/silique-node, a backups directory owned by the
# silique user before the timer runs, a release directory owned correctly
# (not its symlink), and a versioned release named from package.json.
#
# Subcommands:
#   install [opts]         fresh install (default)
#   upgrade <tag|dir>      build a new release, back up first, flip the symlink
#   backup-now             run one backup immediately
#   status                 print installed version and service state
#   uninstall              remove code + units, KEEP the database
#   help                   this message
#
# Safety:
#   - The database (--data-dir) is NEVER removed, not even by 'uninstall'.
#   - 'upgrade' takes a backup BEFORE flipping the symlink and rolls back if the
#     new release fails to start.
#   - An existing install refuses 'install' unless you say 'upgrade'.
#
# Exit codes: 0 ok, 1 runtime failure, 2 usage error.
set -Eeuo pipefail

# --- Resolve the repository root (where this script lives: <root>/infra) -----
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
REPO_DIR="$(cd -P "$(dirname "$SOURCE")/.." >/dev/null 2>&1 && pwd)"

# --- Defaults (overridable via flags) ----------------------------------------
SILIQUE_USER="silique"
INSTALL_DIR="/opt/silique"
NODE_DIR="/opt/silique-node"
DATA_DIR="/var/lib/silique"
BACKUPS_DIR="/var/backups/silique"
CONFIG_FILE="/etc/silique/server.env"
STATE_FILE="/etc/silique/install-state"
UNIT_DIR="/etc/systemd/system"

HOST="127.0.0.1"
PORT="8787"
DOMAIN=""
TLS_MODE="none"
SELF_SIGNED=0
NO_BACKUP_TIMER=0
VERSION_TAG=""
NODE_BIN=""
YES=0
DRY_RUN=0
ROOT_PREFIX=""

# --- Output helpers ----------------------------------------------------------
info() { printf '==> %s\n' "$*" >&2; }
warn() { printf '!! %s\n' "$*" >&2; }
plan() { printf '    [plan] %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$1" >&2; exit "${2:-1}"; }

# --- install-state marker ----------------------------------------------------
# A completed install writes 'complete' to STATE_FILE. Until that marker exists
# an install is treated as incomplete and `install` resumes idempotently from
# where it left off instead of refusing with "use upgrade".
install_complete() { [ -f "$STATE_FILE" ] && grep -qx 'complete' "$STATE_FILE"; }
mark_complete() {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf 'complete\n' > "$STATE_FILE"
  if [ -z "$ROOT_PREFIX" ]; then
    chmod 0644 "$STATE_FILE"
    chown root:root "$STATE_FILE" 2>/dev/null || true
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [command] [options]

Commands:
  install                 Fresh install (default).
  upgrade <tag|dir>       Upgrade to a version (tag) or an existing release dir.
  backup-now              Run one backup now.
  status                  Show installation status.
  uninstall               Remove code and units, KEEP data and backups.
  help                    Show this help.

Options:
  --version <tag>         Version tag to install (default: latest remote tag).
  --port <port>           Listen port (default 8787).
  --host <addr>           Bind address (default 127.0.0.1).
  --domain <name>         Domain for TLS (required for --tls caddy|nginx).
  --tls none|caddy|nginx  TLS setup (default none: server stays on 127.0.0.1).
  --self-signed           Generate a self-signed cert (with --tls nginx).
  --no-backup-timer       Do not install/enable the backup timer.
  --node-bin <path>       Use this node binary instead of downloading Node 24.
  --yes                   Answer yes to every prompt.
  --dry-run               Print the plan and change nothing.
  --root <prefix>         Test mode: stage everything under <prefix>; no root,
                          no network, no systemd.

Path overrides (test mode and custom layouts):
  --install-dir <dir>     Release/symlink root.
  --data-dir <dir>        Database directory.
  --backups-dir <dir>     Backups directory.
EOF
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "required program not found: $1" 1; }
is_root() { [ "${EUID:-$(id -u)}" -eq 0 ]; }

confirm() {
  if [ "$YES" -eq 1 ]; then return 0; fi
  local ans=""
  printf '%s [y/N] ' "$1" >&2
  read -r ans || true
  case "$ans" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

# --- Node helpers ------------------------------------------------------------
node_major() { "$1" -v 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/'; }
node_is_24() { [ "$(node_major "$1")" -ge 24 ] 2>/dev/null; }

resolve_node() {
  # Returns NODE (absolute path) and NODE_DIR, and puts NODE's directory on PATH
  # so later bare `node`/`npm` invocations resolve to the same toolchain instead
  # of whatever happens to be on PATH (fixes "npm: command not found" on hosts
  # where Node lives under /opt/silique-node).
  if [ -n "$NODE_BIN" ]; then
    if [ -x "$NODE_BIN" ]; then NODE="$NODE_BIN"
    elif command -v "$NODE_BIN" >/dev/null 2>&1; then NODE="$(command -v "$NODE_BIN")"
    else die "node binary not found: $NODE_BIN" 1; fi
    node_is_24 "$NODE" || die "node must be >= 24 (got $($NODE -v)): $NODE" 1
    NODE_DIR="$(cd -P "$(dirname "$NODE")/.." >/dev/null 2>&1 && pwd)"
  else
    # Managed node under NODE_DIR.
    NODE="$NODE_DIR/bin/node"
  fi
  export PATH="$(dirname "$NODE"):$PATH"
  return 0
}

install_node() {
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$NODE_BIN" ]; then
      plan "use node binary: $NODE"
    else
      plan "download and verify Node 24 -> $NODE_DIR"
    fi
    return 0
  fi
  # When a node binary is provided or already present, nothing to download.
  [ -n "$NODE_BIN" ] && return 0
  local n="$NODE_DIR/bin/node"
  if [ -x "$n" ] && node_is_24 "$n"; then
    info "Node 24 already installed at $n"
    return 0
  fi
  if [ -n "$ROOT_PREFIX" ]; then
    die "--root mode requires --node-bin (no network access to download Node)" 1
  fi
  local arch
  case "$(uname -m)" in
    x86_64)  arch=x64 ;;
    aarch64) arch=arm64 ;;
    *)       die "unsupported architecture: $(uname -m)" 1 ;;
  esac
  local base="https://nodejs.org/dist/latest-v24.x"
  local tmp; tmp="$(mktemp -d)"
  info "Downloading Node 24 (linux-$arch)..."
  curl -fsSLo "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" || die "failed to download SHASUMS256.txt" 1
  # Find the actual node-v24.*-linux-<arch>.tar.xz shipped under latest-v24.x.
  local fname
  fname="$(awk '{print $2}' "$tmp/SHASUMS256.txt" \
    | grep -E "^node-v24\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz$" | head -1)"
  [ -n "$fname" ] || die "no node-v24.*-linux-$arch tarball listed in SHASUMS256.txt" 1
  curl -fsSLo "$tmp/$fname" "$base/$fname" || die "failed to download $fname" 1
  ( cd "$tmp" && grep "  $fname\$" SHASUMS256.txt | sha256sum -c - ) \
    || die "checksum verification failed for $fname" 1
  info "Node tarball verified."
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$fname" -C "$NODE_DIR" --strip-components=1 || die "failed to extract Node" 1
  rm -rf "$tmp"
  NODE="$NODE_DIR/bin/node"
  info "Installed Node 24 to $NODE_DIR"
}

# --- Version helpers ---------------------------------------------------------
pick_version() {
  # Read package.json version from a checkout directory using the resolved node
  # (never a bare path `node`). A missing/unreadable package.json or an
  # unparseable version is a hard error, not a `0.0.0` fallback (which produced
  # bogus releases/silique-0.0.0).
  [ -f "$1/package.json" ] || die "package.json not found in $1" 1
  local node="${NODE:-}"
  [ -z "$node" ] && { resolve_node; node="$NODE"; }
  local v
  v="$("$node" -p "require('$1/package.json').version" 2>/dev/null)" \
    || die "failed to read version from $1/package.json" 1
  [ -n "$v" ] || die "empty version in $1/package.json" 1
  printf '%s\n' "$v"
}

latest_tag() {
  if [ -n "$ROOT_PREFIX" ]; then echo ""; return 0; fi
  git ls-remote --tags "$REPO_URL" 2>/dev/null \
    | sed -E 's#.*refs/tags/(v?[0-9][^^{}]*)(\^\{\})?#\1#' \
    | sort -V | tail -1 | sed 's/^v//' || echo ""
}

# --- Preflight ---------------------------------------------------------------
preflight() {
  # In --root we skip OS-level checks (no root/systemd/apt).
  if [ -n "$ROOT_PREFIX" ]; then
    if [ -z "$NODE_BIN" ]; then
      need_cmd node || die "no node on PATH; pass --node-bin <path> (required in --root mode)" 1
    else
      [ -x "$NODE_BIN" ] || command -v "$NODE_BIN" >/dev/null 2>&1 \
        || die "node binary not found: $NODE_BIN" 1
    fi
    return 0
  fi
  is_root || die "must run as root (use sudo); for unprivileged testing use --root <prefix>" 1
  need_cmd systemctl || die "systemd not found" 1
  case "$(uname -m)" in x86_64|aarch64) :;; *) die "unsupported arch: $(uname -m)" 1;; esac
  # Check Debian/Ubuntu so apt-get is meaningful.
  if [ ! -f /etc/os-release ] || ! grep -qiE '^ID=(debian|ubuntu)' /etc/os-release; then
    warn "not Debian/Ubuntu; package auto-install disabled"
    NEED_PKGS=""
    return 0
  fi
  local missing=""
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  command -v git  >/dev/null 2>&1 || missing="$missing git"
  command -v gnupg >/dev/null 2>&1 || missing="$missing gnupg"
  dpkg -s ca-certificates >/dev/null 2>&1 || missing="$missing ca-certificates"
  # Select the reverse-proxy package for the requested TLS mode so it is
  # installed BEFORE any config is written (a missing binary previously only
  # surfaced as a late, unreadable `ln` failure).
  case "$TLS_MODE" in
    nginx) command -v nginx >/dev/null 2>&1 || missing="$missing nginx" ;;
    caddy) command -v caddy >/dev/null 2>&1 || missing="$missing caddy" ;;
  esac
  NEED_PKGS="${missing# }"
}

install_packages() {
  if [ "$DRY_RUN" -eq 1 ]; then
    # A dry-run's job is to show the full plan, so for --tls nginx|caddy always
    # plan the proxy package even if it happens to already be present.
    local pkgs="${NEED_PKGS:-}"
    case "$TLS_MODE" in
      nginx) [[ " $pkgs " == *" nginx "* ]] || pkgs="${pkgs:+$pkgs }nginx" ;;
      caddy) [[ " $pkgs " == *" caddy "* ]] || pkgs="${pkgs:+$pkgs }caddy" ;;
    esac
    if [ -n "$pkgs" ]; then
      plan "apt-get install -y $pkgs"
    else
      plan "install packages: none missing"
    fi
    return 0
  fi
  [ -z "${NEED_PKGS:-}" ] && return 0
  if [ -n "$ROOT_PREFIX" ]; then return 0; fi
  info "Installing missing packages:$NEED_PKGS"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y $NEED_PKGS
}

# --- Directory / user setup --------------------------------------------------
setup_dirs() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "create user $SILIQUE_USER (system, nologin)"
    plan "create $DATA_DIR (0700, silique)"
    plan "create $BACKUPS_DIR (0700, silique)"
    plan "create $INSTALL_DIR/releases"
    return 0
  fi
  if [ -n "$ROOT_PREFIX" ]; then
    # Test mode: no user creation; dirs owned by current user but 0700.
    mkdir -p "$DATA_DIR" "$BACKUPS_DIR" "$INSTALL_DIR/releases"
    chmod 0700 "$DATA_DIR" "$BACKUPS_DIR"
    return 0
  fi
  if ! id "$SILIQUE_USER" >/dev/null 2>&1; then
    info "Creating system user '$SILIQUE_USER'"
    useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SILIQUE_USER"
  fi
  # Data dir.
  install -d -o "$SILIQUE_USER" -g "$SILIQUE_USER" -m 0700 "$DATA_DIR"
  # Backups dir (fixes error #2: timer unit runs as silique and must be able to
  # write here on its first nightly run).
  install -d -o "$SILIQUE_USER" -g "$SILIQUE_USER" -m 0700 "$BACKUPS_DIR"
  install -d -o root -g root -m 0755 "$INSTALL_DIR/releases"
}

# --- Code checkout + build ---------------------------------------------------
# Run `npm ci` and, when the release has no dist/ yet, `npm run build`, inside
# $1. On failure, print the tail (~10 lines) of the step's output so the caller's
# error message (and the user) can see WHY preparation failed, not just that it
# did. stdout stays clean; everything goes to stderr.
npm_ci_and_build() {
  local dir="$1"
  local log; log="$(mktemp)"
  if ! ( cd "$dir" && npm ci ) >"$log" 2>&1; then
    warn "npm ci failed in $dir; last output:"
    tail -n 10 "$log" >&2
    rm -f "$log"
    return 1
  fi
  if [ ! -d "$dir/dist" ]; then
    info "dist/ not present; building"
    if ! ( cd "$dir" && npm run build ) >"$log" 2>&1; then
      warn "npm run build failed in $dir; last output:"
      tail -n 10 "$log" >&2
      rm -f "$log"
      return 1
    fi
  fi
  rm -f "$log"
  return 0
}

# Build a release from an existing source directory (the `upgrade <dir>` form).
# Copies the source into a versioned release dir under releases/ (leaving the
# source untouched), runs npm ci (+ build if no dist/), and owns the release dir
# -- exactly the same treatment the git-checkout path gives a release. Echoes
# "<release_dir> <version>" on stdout.
build_release_from_dir() {
  local src="$1"
  local release_dir version
  [ -d "$src" ] || die "source directory not found: $src" 1
  version="$(pick_version "$src")"
  if [ "$DRY_RUN" -eq 1 ]; then
    release_dir="$INSTALL_DIR/releases/silique-$version"
    plan "copy $src -> $release_dir"
    plan "npm ci && npm run build in $release_dir"
    plan "chown -R $SILIQUE_USER:$SILIQUE_USER $release_dir"
    printf '%s %s\n' "$release_dir" "$version"
    return 0
  fi
  release_dir="$INSTALL_DIR/releases/silique-$version"
  # Guard against pointing at the release dir itself (degenerate `upgrade
  # releases/silique-X`), which would copy it onto itself.
  if [ "$(cd -P "$src" 2>/dev/null && pwd)" = "$(cd -P "$release_dir" 2>/dev/null && pwd 2>/dev/null)" ]; then
    printf '%s %s\n' "$release_dir" "$version"
    return 0
  fi
  rm -rf "$release_dir"
  mkdir -p "$release_dir"
  cp -a "$src"/. "$release_dir"/ || die "failed to copy $src to $release_dir" 1
  info "Preparing release from $src (version $version)"
  npm_ci_and_build "$release_dir" || die "npm ci/build failed" 1
  if [ -n "$ROOT_PREFIX" ]; then
    chown -R "$SILIQUE_USER":"$SILIQUE_USER" "$release_dir" 2>/dev/null || true
  else
    chown -R "$SILIQUE_USER":"$SILIQUE_USER" "$release_dir"
  fi
  printf '%s %s\n' "$release_dir" "$version"
}

build_release() {
  # $1 = version tag (optional -> latest). Echoes "release_dir version" to stdout.
  local tag="$1"
  local release_dir version clone_args
  if [ "$DRY_RUN" -eq 1 ]; then
    version="${tag:-LATEST}"
    release_dir="$INSTALL_DIR/releases/silique-$version"
    plan "git clone --depth 1 ${tag:+--branch $tag} -> $release_dir"
    plan "npm ci && npm run build in $release_dir"
    plan "chown -R silique:silique $release_dir"
    printf '%s %s\n' "$release_dir" "$version"
    return 0
  fi
  if [ -n "$ROOT_PREFIX" ] && [ "${SILIQUE_TEST_BUILD:-0}" != "1" ]; then
    # No network: copy the in-repo checkout as the "release".
    version="$(pick_version "$REPO_DIR")"
    release_dir="$INSTALL_DIR/releases/silique-$version"
    rm -rf "$release_dir"
    mkdir -p "$release_dir"
    # Copy source (and prebuilt dist if present) -- no npm/network.
    cp -a "$REPO_DIR"/. "$release_dir"/
    # chown only meaningful when root; ignored otherwise.
    chown -R "$SILIQUE_USER":"$SILIQUE_USER" "$release_dir" 2>/dev/null || true
    printf '%s %s\n' "$release_dir" "$version"
    return 0
  fi
  if [ -n "$tag" ]; then
    clone_args=(--depth 1 --branch "$tag")
  else
    # No explicit --version: resolve latest tag first.
    tag="$(latest_tag)"
    if [ -n "$tag" ]; then clone_args=(--depth 1 --branch "$tag"); else clone_args=(--depth 1); fi
  fi
  local tmp; tmp="$INSTALL_DIR/releases/.clone.$$"
  rm -rf "$tmp"
  info "Cloning ${tag:-HEAD} from $REPO_URL"
  git clone "${clone_args[@]}" "$REPO_URL" "$tmp" >&2 || die "git clone failed" 1
  # Version comes from package.json, NOT the directory/tag name (fixes #7).
  version="$(pick_version "$tmp")"
  release_dir="$INSTALL_DIR/releases/silique-$version"
  rm -rf "$release_dir"
  mv "$tmp" "$release_dir"
  npm_ci_and_build "$release_dir" || die "npm ci/build failed" 1
  # Own the release directory itself (NOT the future symlink) -- fixes #4.
  if [ -n "$ROOT_PREFIX" ]; then
    chown -R "$SILIQUE_USER":"$SILIQUE_USER" "$release_dir" 2>/dev/null || true
  else
    chown -R "$SILIQUE_USER":"$SILIQUE_USER" "$release_dir"
  fi
  # Ensure release_dir is non-empty so a bad checkout cannot yield a dangling
  # symlink (mirrors the old "empty r" footgun at the call site).
  [ -n "$release_dir" ] || die "internal: empty release dir" 1
  # Single stdout line carrying exactly "<release_dir> <version>"; the caller
  # reads it with `read -r r v`. Never let git/npm chatter leak onto stdout.
  printf '%s %s\n' "$release_dir" "$version"
}

# --- env file ----------------------------------------------------------------
write_env() {
  local db="$DATA_DIR/silique.sqlite"
  local need_keys=""
  for k in HOST PORT DATABASE_PATH CORS_ORIGINS; do
    if ! grep -q "^$k=" "$CONFIG_FILE" 2>/dev/null; then need_keys="$need_keys $k"; fi
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $CONFIG_FILE (root:silique 0640) keys:$need_keys"
    return 0
  fi
  mkdir -p "$(dirname "$CONFIG_FILE")"
  if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" <<EOF
HOST=$HOST
PORT=$PORT
DATABASE_PATH=$db
CORS_ORIGINS=
EOF
  else
    info "$CONFIG_FILE exists; adding any missing keys only"
    grep -q '^HOST=' "$CONFIG_FILE" || echo "HOST=$HOST" >> "$CONFIG_FILE"
    grep -q '^PORT=' "$CONFIG_FILE" || echo "PORT=$PORT" >> "$CONFIG_FILE"
    grep -q '^DATABASE_PATH=' "$CONFIG_FILE" || echo "DATABASE_PATH=$db" >> "$CONFIG_FILE"
    grep -q '^CORS_ORIGINS=' "$CONFIG_FILE" || echo "CORS_ORIGINS=" >> "$CONFIG_FILE"
  fi
  chmod 0640 "$CONFIG_FILE"
  if [ -z "$ROOT_PREFIX" ]; then
    chown root:"$SILIQUE_USER" "$CONFIG_FILE"
  fi
}

# --- systemd units (render ExecStart with the real node path) ---------------
render_units() {
  [ -x "$NODE" ] || die "internal: node path not resolved" 1
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "render+install silique.service (ExecStart=$NODE)"
    if [ "$NO_BACKUP_TIMER" -eq 0 ]; then
      plan "render+install silique-backup.service + timer"
    fi
    plan "systemctl daemon-reload && enable --now silique"
    return 0
  fi
  mkdir -p "$UNIT_DIR"
  sed \
    -e "s#@NODE@#$NODE#g" \
    -e "s#@WORKDIR@#$INSTALL_DIR/current#g" \
    -e "s#@CONFIG@#$CONFIG_FILE#g" \
    -e "s#@DATA_DIR@#$DATA_DIR#g" \
    "$REPO_DIR/infra/systemd/silique.service" > "$UNIT_DIR/silique.service"
  sed \
    -e "s#@NODE@#$NODE#g" \
    -e "s#@WORKDIR@#$INSTALL_DIR/current#g" \
    -e "s#@CONFIG@#$CONFIG_FILE#g" \
    -e "s#@BACKUPS_DIR@#$BACKUPS_DIR#g" \
    -e "s#@DATA_DIR@#$DATA_DIR#g" \
    "$REPO_DIR/infra/systemd/silique-backup.service" > "$UNIT_DIR/silique-backup.service"
  cp "$REPO_DIR/infra/systemd/silique-backup.timer" "$UNIT_DIR/silique-backup.timer"
  if [ -n "$ROOT_PREFIX" ]; then return 0; fi
  systemctl daemon-reload
  systemctl enable --now silique.service
  if [ "$NO_BACKUP_TIMER" -eq 0 ]; then
    systemctl enable --now silique-backup.timer
  fi
}

# --- verification ------------------------------------------------------------
# Capture the reason a failed service is down: the last lines of `systemctl
# status silique` (falling back to a short journalctl window). Kept to ~10 lines
# so the user sees WHY without a wall of log.
service_failure_detail() {
  local detail=""
  if command -v systemctl >/dev/null 2>&1; then
    detail="$(systemctl status silique.service 2>&1 | tail -n 10)"
  fi
  if [ -z "$detail" ] && command -v journalctl >/dev/null 2>&1; then
    detail="$(journalctl -u silique -n 20 --no-pager 2>&1 | tail -n 10)"
  fi
  printf '%s' "$detail"
}

verify_health() {
  local base="http://$HOST:$PORT"
  local health discovery
  health="$(curl -fsS "$base/health" 2>/dev/null)" || die "health check failed at $base/health" 1
  echo "$health" | grep -q '"status":"ok"' || die "health: expected status ok, got: $health" 1
  discovery="$(curl -fsS "$base/.well-known/silique" 2>/dev/null)" || die "discovery check failed" 1
  echo "$discovery" | grep -q '"registration":"first-user"' || die "discovery: missing registration first-user" 1
  info "Service verified: /health ok, discovery ok"
}

# Verify the data plane -- service liveness, /health, discovery and a first
# backup passing quick_check -- independently of any proxy/TLS step so a proxy
# failure can never hide a missing or broken backup. Returns nonzero on failure.
verify_data_plane() {
  sleep 2
  if ! systemctl is-active --quiet silique.service; then
    die "silique.service did not reach 'active' state" 1
  fi
  verify_health
  if [ "$NO_BACKUP_TIMER" -eq 0 ]; then
    # Run one backup now and check it passes quick_check.
    systemctl start silique-backup.service || die "backup service failed" 1
    local newest; newest="$(ls -1t "$BACKUPS_DIR"/silique-*.sqlite 2>/dev/null | head -1)"
    [ -n "$newest" ] || die "no backup file produced" 1
    local qc
    if command -v sqlite3 >/dev/null 2>&1; then
      qc="$(sqlite3 "$newest" 'PRAGMA quick_check;' 2>/dev/null)"
    else
      qc="$("$NODE" --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('PRAGMA quick_check').get().quick_check);d.close();" "$newest")"
    fi
    [ "$qc" = "ok" ] || die "backup quick_check != ok (got: $qc)" 1
    info "Backup verified: quick_check=ok"
  fi
}

# --- Do a single backup ------------------------------------------------------
do_backup() {
  local db="$DATA_DIR/silique.sqlite"
  local node="${NODE:-}"
  if [ -z "$node" ]; then resolve_node; node="$NODE"; fi
  mkdir -p "$BACKUPS_DIR"
  if [ -n "$ROOT_PREFIX" ]; then chmod 0700 "$BACKUPS_DIR" 2>/dev/null || true; fi
  if [ "$DRY_RUN" -eq 1 ]; then plan "backup to $BACKUPS_DIR"; return 0; fi
  if [ -n "$ROOT_PREFIX" ]; then
    # Test mode: no live service / real DB; just ensure the dir exists.
    info "Test mode: skipping actual backup (no live database)"
    return 0
  fi
  DATABASE_PATH="$db" "$node" "$INSTALL_DIR/current/infra/backup/backup.mjs" "$BACKUPS_DIR" \
    || die "backup failed" 1
  info "Backup written to $BACKUPS_DIR"
}

# --- TLS setup ---------------------------------------------------------------
require_proxy() {
  # Fail before anything is written/enabled when the reverse proxy program the
  # requested TLS mode needs is missing. This is also the message users get on a
  # resumed incomplete install where the package step never ran. In --dry-run we
  # only plan (install_packages already printed the package step), so do not die.
  [ "$DRY_RUN" -eq 1 ] && return 0
  command -v "$1" >/dev/null 2>&1 || \
    die "reverse proxy program '$1' not found; install it first (e.g. 'apt-get install -y $1') and re-run this command to resume" 1
}

setup_tls() {
  case "$TLS_MODE" in
    none)
      info "TLS mode 'none': server stays on 127.0.0.1; point a reverse proxy at it."
      return 0
      ;;
    caddy)
      [ -n "$DOMAIN" ] || die "--tls caddy requires --domain" 2
      require_proxy caddy
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "write Caddyfile for $DOMAIN"
        return 0
      fi
      local caddyfile="/etc/caddy/Caddyfile"
      mkdir -p "$(dirname "$caddyfile")"
      sed "s/notes\.example\.com/$DOMAIN/g" "$REPO_DIR/infra/caddy/Caddyfile" > "$caddyfile"
      info "Caddy config written to $caddyfile"
      ;;
    nginx)
      [ -n "$DOMAIN" ] || die "--tls nginx requires --domain" 2
      require_proxy nginx
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "write nginx config for $DOMAIN (cert: $([ $SELF_SIGNED -eq 1 ] && echo self-signed || echo existing))"
        return 0
      fi
      local certdir nginx_root conf
      if [ -n "$ROOT_PREFIX" ]; then
        certdir="$ROOT_PREFIX/etc/nginx/silique"
        nginx_root="$ROOT_PREFIX/etc/nginx"
      else
        certdir="/etc/nginx/silique"
        nginx_root="/etc/nginx"
      fi
      mkdir -p "$certdir"
      local cert_path="$certdir/cert.pem" key_path="$certdir/key.pem"
      if [ "$SELF_SIGNED" -eq 1 ]; then
        # Self-signed: SAN = IP or domain, 30 days.
        local san
        if [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then san="IP:$DOMAIN"; else san="DNS:$DOMAIN"; fi
        need_cmd openssl
        openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
          -keyout "$key_path" -out "$cert_path" \
          -subj "/CN=$DOMAIN" -addext "subjectAltName=$san" \
          || die "failed to generate self-signed cert" 1
        info "Self-signed cert written to $certdir (30 days)"
      else
        # Use existing cert paths under /etc/letsencrypt/live/<domain>.
        cert_path="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
        key_path="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
      fi
      local conf="$nginx_root/sites-available/silique"
      mkdir -p "$(dirname "$conf")"
      cat > "$conf" <<EOF
server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     $cert_path;
    ssl_certificate_key $key_path;

    location / {
        proxy_pass         http://$HOST:$PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        client_max_body_size 4m;
    }
}

server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
EOF
      if [ -z "$ROOT_PREFIX" ]; then
        # Enable the site, then validate the finished config with `nginx -t`;
        # on failure remove the link again so nginx is never left broken.
        ln -sf "$conf" "$nginx_root/sites-enabled/silique"
        if ! nginx -t >/dev/null 2>&1; then
          rm -f "$nginx_root/sites-enabled/silique"
          die "nginx config failed validation ('nginx -t'); disabled and removed" 1
        fi
        systemctl reload nginx 2>/dev/null \
          || systemctl start nginx 2>/dev/null \
          || warn "could not reload/start nginx; start it manually"
      fi
      info "nginx config written to $conf"
      ;;
    *) die "invalid --tls: $TLS_MODE" 2 ;;
  esac
}

# --- install -----------------------------------------------------------------
cmd_install() {
  preflight
  # Existing install guard. A server.env with the 'complete' marker means a full
  # install already finished -> refuse and point at 'upgrade'. A server.env
  # WITHOUT the marker means a previous run died halfway -> resume idempotently.
  if [ -f "$CONFIG_FILE" ] && install_complete; then
    die "existing installation found ($CONFIG_FILE). Use 'upgrade' instead." 2
  fi
  if [ -f "$CONFIG_FILE" ]; then
    info "Found incomplete installation at $CONFIG_FILE; resuming from where it stopped"
  fi
  # Install missing packages right after preflight, BEFORE any network use
  # (curl/git below depend on them). On a minimal Debian this fixes
  # "curl: command not found". For --tls nginx|caddy this also installs the
  # proxy so it exists before its config is written.
  install_packages
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "== install plan =="
    [ -n "$ROOT_PREFIX" ] && plan "test mode: root prefix $ROOT_PREFIX"
    resolve_node
    install_node
    setup_dirs
    local r v
    read -r r v < <(build_release "${VERSION_TAG:-}")
    plan "symlink $INSTALL_DIR/current -> $r"
    write_env
    render_units
    # Verification of the data plane is planned BEFORE the proxy step, so a TLS
    # failure can never hide a missing/backup-less install.
    plan "verify data plane: service active, /health, discovery, first backup quick_check"
    setup_tls
    plan "mark install complete (write $STATE_FILE)"
    echo "== end of plan (nothing changed) =="
    return 0
  fi
  resolve_node
  install_node
  setup_dirs
  # Install order for a real run. The release + symlink + env + units are
  # idempotent, so a resume re-runs them safely.
  local r v; read -r r v < <(build_release "${VERSION_TAG:-}")
  [ -n "$r" ] || die "internal: empty release dir from build_release" 1
  ln -sfn "$r" "$INSTALL_DIR/current"
  # Symlink target ownership is handled inside build_release on the real dir.
  write_env
  render_units
  # Verify the data plane BEFORE any proxy/TLS work. This ordering guarantees a
  # TLS failure cannot hide that the service or backup never got stood up, and
  # keeps `apt`/proxy breakage from masking missing backups.
  if [ -n "$ROOT_PREFIX" ]; then
    info "Test mode: skipping live service/health verification"
  else
    verify_data_plane
  fi
  # TLS is set up only after the data plane is confirmed working.
  setup_tls
  # Only now is the install genuinely complete.
  mark_complete
  summary
}

# --- upgrade -----------------------------------------------------------------
cmd_upgrade() {
  local arg="${1:-}"
  [ -f "$CONFIG_FILE" ] || die "no existing installation at $CONFIG_FILE (use 'install')" 1
  preflight
  resolve_node
  # Backup BEFORE flipping the symlink.
  info "Pre-upgrade backup"
  do_backup
  local old=""
  [ -L "$INSTALL_DIR/current" ] && old="$(readlink -f "$INSTALL_DIR/current")"
  local r v
  if [ -d "$arg" ]; then
    read -r r v < <(build_release_from_dir "$arg")
  else
    read -r r v < <(build_release "${arg:-${VERSION_TAG:-}}")
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "symlink flip: $INSTALL_DIR/current -> $r"
    plan "systemctl restart silique"
    echo "== end of plan =="
    return 0
  fi
  ln -sfn "$r" "$INSTALL_DIR/current"
  if [ -n "$ROOT_PREFIX" ]; then
    info "Test mode: symlink flipped to $r"
    return 0
  fi
  systemctl restart silique.service
  sleep 2
  if systemctl is-active --quiet silique.service && verify_health; then
    info "Upgrade to $v succeeded"
  else
    warn "new release failed; rolling back"
    # Tell the user WHY it failed (the last lines of the service status), not
    # just that it did.
    warn "$(service_failure_detail)"
    if [ -n "$old" ]; then
      ln -sfn "$old" "$INSTALL_DIR/current"
      systemctl restart silique.service
    fi
    die "upgrade failed; rolled back to previous release" 1
  fi
}

# --- backup-now --------------------------------------------------------------
cmd_backup_now() {
  [ -f "$CONFIG_FILE" ] || die "no installation at $CONFIG_FILE" 1
  resolve_node
  do_backup
}

# --- status ------------------------------------------------------------------
cmd_status() {
  local cur="(no symlink)"
  [ -L "$INSTALL_DIR/current" ] && cur="$(readlink -f "$INSTALL_DIR/current")"
  echo "install-dir: $INSTALL_DIR"
  echo "current:     $cur"
  [ -f "$CONFIG_FILE" ] && echo "env:         $CONFIG_FILE" || echo "env:         (missing)"
  if install_complete; then
    echo "install:     complete"
  else
    echo "install:     incomplete (re-run 'install' to resume)"
  fi
  if [ -n "$ROOT_PREFIX" ]; then
    echo "service:     n/a (--root test mode)"
    return 0
  fi
  local st; st="$(systemctl is-active silique.service 2>/dev/null || echo unknown)"
  echo "service:     $st"
  if systemctl list-timers silique-backup.timer >/dev/null 2>&1; then
    echo "backup:      timer enabled"
  fi
}

# --- uninstall ---------------------------------------------------------------
cmd_uninstall() {
  local db="$DATA_DIR/silique.sqlite"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "== uninstall plan =="
    plan "stop/disable silique + backup timer; remove units"
    plan "remove $INSTALL_DIR"
    plan "remove user $SILIQUE_USER"
    plan "KEEP $DATA_DIR (database) and $BACKUPS_DIR"
    return 0
  fi
  if [ -n "$ROOT_PREFIX" ]; then
    rm -rf "$INSTALL_DIR"
    rm -rf "$ROOT_PREFIX/etc/systemd/system/silique.service" \
           "$ROOT_PREFIX/etc/systemd/system/silique-backup.service" \
           "$ROOT_PREFIX/etc/systemd/system/silique-backup.timer"
    rm -f "$STATE_FILE"
  else
    is_root || die "must run as root to uninstall" 1
    systemctl disable --now silique.service 2>/dev/null || true
    systemctl disable --now silique-backup.timer 2>/dev/null || true
    rm -f "$UNIT_DIR/silique.service" "$UNIT_DIR/silique-backup.service" "$UNIT_DIR/silique-backup.timer"
    systemctl daemon-reload
    rm -rf "$INSTALL_DIR"
    rm -f "$STATE_FILE"
    userdel "$SILIQUE_USER" 2>/dev/null || true
  fi
  echo "Uninstalled. Database preserved at: $db"
  echo "Backups preserved at: $BACKUPS_DIR"
}

# --- summary -----------------------------------------------------------------
summary() {
  local proto="http://$HOST:$PORT"
  if [ "$TLS_MODE" != "none" ]; then proto="https://${DOMAIN:-$HOST}"; fi
  cat <<EOF
== Installation complete ==
  Server address:  $proto
  Env file:        $CONFIG_FILE
  Data directory:  $DATA_DIR
  Backups:         $BACKUPS_DIR
EOF
  if [ "$TLS_MODE" = "none" ]; then
    echo "  TLS:            none -- server bound to $HOST; use a reverse proxy for HTTPS."
  fi
  cat <<EOF
  Account:         created from the Silique app on first launch.

  Manage with:
    sudo $0 status
    sudo $0 backup-now
    sudo $0 upgrade <version>
EOF
}

# --- dispatch ----------------------------------------------------------------
main() {
  local cmd="install" upgrade_arg=""
  # First positional may be a subcommand.
  if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
    cmd="$1"; shift
    if [ "$cmd" = "upgrade" ] && [ $# -gt 0 ] && [[ "$1" != -* ]]; then
      upgrade_arg="$1"; shift
    fi
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)        [ $# -ge 2 ] || { usage >&2; exit 2; }; VERSION_TAG="$2"; shift 2 ;;
      --port)           [ $# -ge 2 ] || { usage >&2; exit 2; }; PORT="$2"; shift 2 ;;
      --host)           [ $# -ge 2 ] || { usage >&2; exit 2; }; HOST="$2"; shift 2 ;;
      --domain)         [ $# -ge 2 ] || { usage >&2; exit 2; }; DOMAIN="$2"; shift 2 ;;
      --tls)            [ $# -ge 2 ] || { usage >&2; exit 2; }; TLS_MODE="$2"; shift 2 ;;
      --self-signed)    SELF_SIGNED=1; shift ;;
      --no-backup-timer) NO_BACKUP_TIMER=1; shift ;;
      --node-bin)       [ $# -ge 2 ] || { usage >&2; exit 2; }; NODE_BIN="$2"; shift 2 ;;
      --yes)            YES=1; shift ;;
      --dry-run)        DRY_RUN=1; shift ;;
      --root)           [ $# -ge 2 ] || { usage >&2; exit 2; }; ROOT_PREFIX="$2"; shift 2 ;;
      --install-dir)    [ $# -ge 2 ] || { usage >&2; exit 2; }; INSTALL_DIR="$2"; shift 2 ;;
      --data-dir)       [ $# -ge 2 ] || { usage >&2; exit 2; }; DATA_DIR="$2"; shift 2 ;;
      --backups-dir)    [ $# -ge 2 ] || { usage >&2; exit 2; }; BACKUPS_DIR="$2"; shift 2 ;;
      -h|--help)        usage; exit 0 ;;
      --)               shift; break ;;
      -*)               { printf 'error: unknown option: %s\n' "$1" >&2; usage >&2; exit 2; } ;;
      *)                { printf 'error: unexpected argument: %s\n' "$1" >&2; usage >&2; exit 2; } ;;
    esac
  done

  # Validate flag combinations.
  case "$TLS_MODE" in none|caddy|nginx) :;; *) { printf 'error: invalid --tls value: %s (use none|caddy|nginx)\n' "$TLS_MODE" >&2; usage >&2; exit 2; };; esac
  if [ "$SELF_SIGNED" -eq 1 ] && [ "$TLS_MODE" != "nginx" ]; then
    { printf 'error: --self-signed requires --tls nginx\n' >&2; usage >&2; exit 2; }
  fi
  if [ "$TLS_MODE" != "none" ] && [ -z "$DOMAIN" ]; then
    { printf 'error: --tls %s requires --domain\n' "$TLS_MODE" >&2; usage >&2; exit 2; }
  fi

  # Apply --root prefix to fixed paths.
  if [ -n "$ROOT_PREFIX" ]; then
    INSTALL_DIR="$ROOT_PREFIX$INSTALL_DIR"
    NODE_DIR="$ROOT_PREFIX$NODE_DIR"
    DATA_DIR="$ROOT_PREFIX$DATA_DIR"
    BACKUPS_DIR="$ROOT_PREFIX$BACKUPS_DIR"
    CONFIG_FILE="$ROOT_PREFIX$CONFIG_FILE"
    STATE_FILE="$ROOT_PREFIX$STATE_FILE"
    UNIT_DIR="$ROOT_PREFIX/etc/systemd/system"
  fi

  case "$cmd" in
    install)      INSTALL_CMD=install; cmd_install ;;
    upgrade)      INSTALL_CMD=upgrade; cmd_upgrade "$upgrade_arg" ;;
    backup-now)   INSTALL_CMD=backup-now; cmd_backup_now ;;
    status)       INSTALL_CMD=status; cmd_status ;;
    uninstall)    INSTALL_CMD=uninstall; cmd_uninstall ;;
    help)         INSTALL_CMD=help; usage ;;
    *)            die "unknown command: $cmd (see 'help')" 2 ;;
  esac
}

# When `install` fails partway, print what is already in place and exactly how
# to finish, so a half-done install (server up but no TLS/backup) is never left
# without a recovery path.
INSTALL_CMD=""
install_error_hint() {
  local code=$?
  [ "$code" -eq 0 ] && return 0
  if [ "${INSTALL_CMD:-}" = "install" ] && [ -f "$CONFIG_FILE" ] && ! install_complete; then
    printf '\nInstall did not finish. Everything completed so far is preserved.\n' >&2
    printf 'Re-run to resume idempotently:  sudo %s install\n' "$0" >&2
    printf 'Inspect current state with:     sudo %s status\n' "$0" >&2
  fi
  return 0
}
trap install_error_hint EXIT

REPO_URL="https://github.com/Haniewicz/silique-self-hosted.git"
main "$@"
