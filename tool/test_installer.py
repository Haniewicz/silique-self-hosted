#!/usr/bin/env python3
"""Test harness for infra/install.sh.

Runs the installer in unprivileged test mode (--root <tmpdir>) with no root,
no network, and no systemd. Uses only the Python standard library.

Exit code 0 means all checks passed; anything else prints a diagnostic and
fails. The adapter runs this via `npm run test:all`.
"""

import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALLER = os.path.join(REPO_DIR, "infra", "install.sh")
DOCS = os.path.join(REPO_DIR, "docs", "self-hosting.md")


def run_installer(*args, expect=0, env=None):
    """Run `bash infra/install.sh <args>` and return (returncode, stdout)."""
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        ["bash", INSTALLER, *args],
        cwd=REPO_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=full_env,
    )
    if expect is not None and proc.returncode != expect:
        raise AssertionError(
            f"installer {' '.join(args)!r} exited {proc.returncode}, "
            f"expected {expect}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return proc.returncode, proc.stdout, proc.stderr


def node_bin():
    node = shutil.which("node")
    if not node:
        raise AssertionError("node not found on PATH (required for test mode)")
    return node


def _write_script(path, body):
    with open(path, "w") as f:
        f.write("#!/bin/bash\n")
        f.write(body)
        if not body.endswith("\n"):
            f.write("\n")
    os.chmod(path, 0o755)


# Build a PATH that still provides every standard tool the installer uses
# (bash, coreutils, …) but has NO `node`/`npm`/`npx` on it, by symlinking all
# of /usr/bin and /bin into a staging dir, minus the Node binaries. Node/npm are
# then only reachable through the fake --node-bin directory (or real --node-bin).
def _make_no_node_path(tmp):
    staged = os.path.join(tmp, "nodenode-bin")
    os.makedirs(staged, exist_ok=True)
    for d in ("/usr/bin", "/bin"):
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if name in ("node", "npm", "npx", "corepack"):
                continue
            src = os.path.join(d, name)
            dst = os.path.join(staged, name)
            if not os.path.islink(dst) and not os.path.exists(dst) \
                    and (os.path.isfile(src) or os.path.islink(src)):
                os.symlink(src, dst)
    return staged


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="silique-inst-")
        self.root = os.path.join(self.tmp, "root")
        self.node = node_bin()
        # Common flags for a full unprivileged install.
        self.base = ["--root", self.root, "--node-bin", self.node]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_01_dry_run_creates_nothing(self):
        """--dry-run prints a plan and creates nothing under --root."""
        _, out, err = run_installer(*self.base, "--dry-run")
        self.assertFalse(
            os.path.exists(self.root),
            "--dry-run must not create anything under --root",
        )
        combined = out + err
        self.assertIn("plan", combined.lower())
        self.assertIn("install", combined.lower())

    def test_02a_unknown_flag_exits_2(self):
        rc, _, err = run_installer(*self.base, "--bogus", expect=2)
        self.assertIn("usage", err.lower())

    def test_02b_missing_value_exits_2(self):
        rc, _, err = run_installer("--tls", expect=2)
        self.assertIn("usage", err.lower())

    def test_03_self_signed_requires_tls(self):
        rc, _, err = run_installer("--self-signed", expect=2)
        self.assertIn("nginx", err.lower())

    def do_install(self):
        run_installer(*self.base)

    def test_04_rendered_unit_node_path(self):
        """Rendered unit points at the provided node, never /opt/silique-node."""
        self.do_install()
        unit = os.path.join(self.root, "etc", "systemd", "system", "silique.service")
        self.assertTrue(os.path.isfile(unit), "silique.service not rendered")
        with open(unit) as f:
            content = f.read()
        self.assertIn(f"ExecStart={self.node} ", content,
                      "ExecStart must use the --node-bin path")
        self.assertNotIn("/opt/silique-node", content,
                         "unit must not hardcode /opt/silique-node under --root")

    def test_05_env_file_four_keys_0640(self):
        self.do_install()
        env = os.path.join(self.root, "etc", "silique", "server.env")
        self.assertTrue(os.path.isfile(env), "server.env not created")
        with open(env) as f:
            content = f.read()
        keys = {}
        for line in content.splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                keys[k] = v
        required = ["HOST", "PORT", "DATABASE_PATH", "CORS_ORIGINS"]
        for k in required:
            self.assertIn(k, keys, f"missing key {k} in server.env")
        # Exactly four keys, no duplicates.
        self.assertEqual(len(keys), 4, f"server.env has {len(keys)} keys, expected 4")
        mode = stat.S_IMODE(os.stat(env).st_mode)
        self.assertEqual(mode, 0o640, f"server.env mode {oct(mode)} != 0640")

    def test_06_backups_dir_0700(self):
        self.do_install()
        backups = os.path.join(self.root, "var", "backups", "silique")
        self.assertTrue(os.path.isdir(backups), "backups dir not created")
        mode = stat.S_IMODE(os.stat(backups).st_mode)
        self.assertEqual(mode, 0o700, f"backups dir mode {oct(mode)} != 0700")

    def test_07_second_install_and_upgrade(self):
        """Second install exits 2; upgrade flips symlink and preserves env+db."""
        self.do_install()
        env = os.path.join(self.root, "etc", "silique", "server.env")
        data = os.path.join(self.root, "var", "lib", "silique")
        db = os.path.join(data, "silique.sqlite")
        # Create a real-enough SQLite database file for checksum comparison.
        with open(db, "wb") as f:
            f.write(b"pretend-database-bytes")

        with open(env, "rb") as f:
            env_before = hashlib.sha256(f.read()).hexdigest()
        with open(db, "rb") as f:
            db_before = hashlib.sha256(f.read()).hexdigest()

        # Second install without 'upgrade' must exit 2.
        rc, _, err = run_installer(*self.base, expect=2)
        self.assertIn("upgrade", err.lower())

        # Build a fake "new" release dir and upgrade to it (katalog form).
        releases = os.path.join(self.root, "opt", "silique", "releases")
        new_dir = os.path.join(releases, "silique-9.9.9")
        os.makedirs(new_dir, exist_ok=True)
        with open(os.path.join(new_dir, "package.json"), "w") as f:
            f.write('{"name":"silique-server","version":"9.9.9"}')

        run_installer("upgrade", new_dir, *self.base)

        current = os.path.join(self.root, "opt", "silique", "current")
        self.assertTrue(os.path.islink(current), "current is not a symlink")
        target = os.path.realpath(current)
        self.assertEqual(os.path.realpath(target), os.path.realpath(new_dir),
                         "upgrade did not flip the symlink to the new release")

        with open(env, "rb") as f:
            env_after = hashlib.sha256(f.read()).hexdigest()
        with open(db, "rb") as f:
            db_after = hashlib.sha256(f.read()).hexdigest()
        self.assertEqual(env_after, env_before, "server.env was modified by upgrade")
        self.assertEqual(db_after, db_before, "database was modified by upgrade")

    def test_08_uninstall_preserves_db(self):
        self.do_install()
        data = os.path.join(self.root, "var", "lib", "silique")
        db = os.path.join(data, "silique.sqlite")
        with open(db, "wb") as f:
            f.write(b"real-db-content")
        rc, out, err = run_installer("uninstall", *self.base)
        self.assertTrue(os.path.isfile(db), "uninstall removed the database file")
        combined = out + err
        self.assertIn(db, combined, "uninstall must print the database path")
        # Code tree removed.
        inst = os.path.join(self.root, "opt", "silique")
        self.assertFalse(os.path.exists(inst), "uninstall did not remove code dir")

    def test_09_dry_run_plan_order(self):
        """--dry-run plan lists the package-install step before the Node step."""
        _, out, err = run_installer(*self.base, "--dry-run")
        combined = out + err
        self.assertIn("install packages", combined,
                      "plan must contain an install-packages step")
        self.assertIn("node binary", combined,
                      "plan must contain a Node step")
        self.assertLess(combined.index("install packages"),
                        combined.index("node binary"),
                        "install-packages step must come before the Node step")

    def test_10_npm_resolved_from_node_dir(self):
        """The installer invokes `npm` from the Node directory (PATH export)."""
        fake_node = os.path.join(self.tmp, "node")
        mock_bin = os.path.join(self.tmp, "bin")
        npm_log = os.path.join(self.tmp, "npm.log")
        os.makedirs(fake_node)
        os.makedirs(mock_bin)

        # A node that reports itself as 24.x and answers `-p` with a version.
        _write_script(os.path.join(fake_node, "node"),
                      f'if [ "$1" = "-v" ]; then echo v24.0.0; '
                      f'elif [ "$1" = "-p" ]; then echo 0.2.3; fi')
        # The npm that must be found in the node directory.
        _write_script(os.path.join(fake_node, "npm"),
                      f'echo "$*" >> "{npm_log}"')
        # A git mock that produces a minimal release tree (and no network).
        _write_script(os.path.join(mock_bin, "git"),
                      'if [ "$1" = "ls-remote" ]; then exit 0; fi\n'
                      'dest="${@: -1}"\n'
                      'mkdir -p "$dest/dist"\n'
                      'printf \'{"name":"silique-server","version":"0.2.3"}\' '
                      '> "$dest/package.json"\n'
                      'echo ok > "$dest/dist/index.js"')

        # PATH must NOT contain the node dir (only --node-bin points at it) and
        # must not contain the real node/npm; mock git comes from mock_bin.
        base_path = _make_no_node_path(self.tmp)
        env = {
            "PATH": os.pathsep.join([mock_bin, base_path]),
            "SILIQUE_TEST_BUILD": "1",
        }
        run_installer("--root", self.root,
                      "--node-bin", os.path.join(fake_node, "node"),
                      "--version", "0.2.3", env=env)

        self.assertTrue(os.path.isfile(npm_log),
                        "npm was never invoked by the installer")
        with open(npm_log) as f:
            called = f.read().split()
        self.assertIn("ci", called,
                      "installer did not run `npm ci` using npm from the node dir")

    def test_11_no_node_on_path_version(self):
        """Release dir is named from package.json, never a 0.0.0 fallback."""
        env = {"PATH": _make_no_node_path(self.tmp)}
        run_installer(*self.base, env=env)
        releases = os.path.join(self.root, "opt", "silique", "releases")
        self.assertTrue(os.path.isdir(releases), "releases dir missing")
        names = os.listdir(releases)
        self.assertNotIn("silique-0.0.0", names,
                         "release dir must never be named silique-0.0.0")
        self.assertTrue(any(n.startswith("silique-") for n in names),
                        "a versioned release dir must exist")

    def test_12_stdout_contract(self):
        """git stdout noise must not corrupt the `read -r r v` result."""
        fake_node = os.path.join(self.tmp, "node")
        mock_bin = os.path.join(self.tmp, "bin")
        os.makedirs(fake_node)
        os.makedirs(mock_bin)

        # A node that reports 24.x and answers `-p` with a version, plus a no-op
        # npm sitting in the SAME directory (so the PATH export finds it, not the
        # real npm in /usr/local/bin).
        _write_script(os.path.join(fake_node, "node"),
                      f'if [ "$1" = "-v" ]; then echo v24.0.0; '
                      f'elif [ "$1" = "-p" ]; then echo 0.2.3; fi')
        _write_script(os.path.join(fake_node, "npm"), "")
        # git writes an EXTRA line to stdout (the old bug) before creating a real
        # release tree; build_release must keep stdout to "<dir> <version>".
        _write_script(os.path.join(mock_bin, "git"),
                      'echo noise-on-stdout\n'
                      'if [ "$1" = "ls-remote" ]; then exit 0; fi\n'
                      'dest="${@: -1}"\n'
                      'mkdir -p "$dest/dist"\n'
                      'printf \'{"name":"silique-server","version":"0.2.3"}\' '
                      '> "$dest/package.json"\n'
                      'echo ok > "$dest/dist/index.js"')
        env = {
            "PATH": os.pathsep.join([
                mock_bin, _make_no_node_path(self.tmp)]),
            "SILIQUE_TEST_BUILD": "1",
        }
        run_installer("--root", self.root,
                      "--node-bin", os.path.join(fake_node, "node"),
                      "--version", "0.2.3", env=env)
        current = os.path.join(self.root, "opt", "silique", "current")
        self.assertTrue(os.path.islink(current),
                        "current must be a symlink")
        target = os.path.realpath(current)
        self.assertTrue(os.path.isdir(target),
                        "current must point to an existing directory")
        self.assertTrue(os.listdir(target),
                        "current must point to a non-empty directory")

    def test_13_manual_units_have_no_placeholders(self):
        """Copyable [Service] blocks in the guide must contain no @ placeholders."""
        with open(DOCS) as f:
            text = f.read()
        # The guide must no longer tell users to `cp` the raw templates.
        self.assertNotRegex(
            text,
            r"cp\s+[^\n]*infra/systemd/silique(?:-backup)?\.service",
            "guide must not instruct copying the template .service files verbatim",
        )
        # Every ```-fenced [Service] block is a copyable unit; none may contain '@'.
        for block in re.findall(r"```[^\n]*\n(.*?)```", text, flags=re.DOTALL):
            if "[Service]" in block and "@" in block:
                self.fail(
                    "a copyable unit block contains a placeholder:\n" + block
                )

    def test_14_tls_nginx_install_planned(self):
        """--dry-run --tls nginx plans the nginx package BEFORE the proxy config."""
        _, out, err = run_installer(
            *self.base, "--dry-run", "--tls", "nginx",
            "--self-signed", "--domain", "x"
        )
        combined = out + err
        self.assertIn("install -y", combined,
                      "plan must contain an apt-get install step")
        self.assertIn("nginx", combined,
                      "plan must mention the nginx package")
        self.assertIn("write nginx config", combined,
                      "plan must contain the proxy-config step")
        # The package install must come before the proxy config step.
        self.assertLess(
            combined.index("install -y nginx"),
            combined.index("write nginx config"),
            "nginx package install must be planned before writing proxy config",
        )

    def test_15_tls_missing_proxy_fails_early(self):
        """--root --tls nginx without nginx on PATH fails with a clear message."""
        # Ensure nginx is absent from PATH regardless of the test host.
        stripped = _make_no_node_path(self.tmp)
        # _make_no_node_path leaves symlinks for standard tools; drop nginx/caddy
        # symlinks if they somehow exist there, and run with a PATH that has the
        # real node via --node-bin but no nginx.
        nginx_link = os.path.join(stripped, "nginx")
        if os.path.islink(nginx_link) or os.path.exists(nginx_link):
            os.remove(nginx_link)
        env = {"PATH": stripped}
        rc, out, err = run_installer(
            *self.base, "--tls", "nginx", "--self-signed", "--domain", "x",
            env=env, expect=None,
        )
        self.assertNotEqual(rc, 0, "install must fail when nginx is missing")
        combined = out + err
        self.assertIn("nginx", combined,
                      "error must name nginx")
        self.assertNotIn("ln: failed to create symbolic link", combined,
                         "must fail early with a clear message, not a late ln error")

    def test_16_install_resumes_incomplete(self):
        """Partial install (server.env, no marker) resumes; complete marker -> upgrade."""
        state = os.path.join(self.root, "etc", "silique", "install-state")
        env = os.path.join(self.root, "etc", "silique", "server.env")

        # Simulate a partial install: server.env exists but no complete marker.
        os.makedirs(os.path.dirname(env), exist_ok=True)
        with open(env, "w") as f:
            f.write("HOST=127.0.0.1\n")

        # 'install' must resume (rc=0) and finish by writing the marker.
        run_installer(*self.base)
        self.assertTrue(os.path.isfile(state), "install-state marker not written")
        with open(state) as f:
            self.assertTrue("complete" in f.read(),
                            "install-state marker must record 'complete'")

        # Now a fresh install with the marker present must demand 'upgrade' (rc=2).
        rc, _, err = run_installer(*self.base, expect=2)
        self.assertIn("upgrade", err.lower(),
                      "a completed install must point at 'upgrade'")

    def test_17_verify_before_tls(self):
        """The dry-run plan verifies the data plane BEFORE the TLS step."""
        _, out, err = run_installer(
            *self.base, "--dry-run", "--tls", "nginx",
            "--self-signed", "--domain", "x"
        )
        combined = out + err
        self.assertIn("backup", combined,
                      "plan must include the backup/data-plane verification")
        self.assertIn("write nginx config", combined,
                      "plan must include the TLS step")
        # Data-plane verification (health/backup) must be planned before TLS.
        verify_idx = combined.index("verify data plane")
        tls_idx = combined.index("write nginx config")
        self.assertLess(verify_idx, tls_idx,
                        "data-plane verification must be planned before TLS")

    def test_18_guide_installs_proxy(self):
        """The manual guide installs nginx (and Caddy) in the proxy sections."""
        with open(DOCS) as f:
            text = f.read()
        # nginx package install present in the proxy/TLS section.
        self.assertIn("apt-get install -y nginx", text,
                      "guide must install nginx in the proxy section")
        # Caddy equivalent: either an explicit install command or a clear
        # reference to Caddy's own installation documentation.
        self.assertTrue(
            ("apt-get install -y caddy" in text)
            or re.search(r"caddyserver\.com/docs/install", text),
            "guide must install Caddy or point to the Caddy install docs",
        )

    def test_19_guide_has_no_tag_dependency(self):
        """The guide must not depend on git tags; version comes from package.json."""
        with open(DOCS) as f:
            text = f.read()
        self.assertNotIn("git ls-remote --tags", text,
                         "guide must not use `git ls-remote --tags`")
        self.assertNotIn("clone --branch", text,
                         "guide must not use `git clone --branch`")
        self.assertRegex(
            text,
            r"""require\(["']\./package\.json["']\)\.version""",
            "guide must read the version from package.json",
        )

    def test_20_guide_exports_node_path(self):
        """The install section exports /opt/silique-node/bin before the first npm ci."""
        with open(DOCS) as f:
            text = f.read()
        self.assertIn("export PATH=/opt/silique-node/bin:$PATH", text,
                      "guide must export /opt/silique-node/bin on PATH")
        export_idx = text.index("export PATH=/opt/silique-node/bin:$PATH")
        npm_ci_idx = text.index("npm ci")
        self.assertLess(
            export_idx, npm_ci_idx,
            "PATH export must come before the first `npm ci`",
        )

    def test_21_guide_upgrade_without_tags(self):
        """The Updating section must not use --branch and must name package.json or install.sh upgrade."""
        with open(DOCS) as f:
            text = f.read()
        start = text.index("## Updating the server")
        end = text.index("## Backups", start)
        updating = text[start:end]
        self.assertNotIn("--branch", updating,
                         "Updating section must not use `--branch`")
        self.assertTrue(
            ("package.json" in updating)
            or ("install.sh upgrade" in updating),
            "Updating section must mention package.json or install.sh upgrade",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
