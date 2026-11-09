#!/usr/bin/env python3
"""Test harness for infra/install.sh.

Runs the installer in unprivileged test mode (--root <tmpdir>) with no root,
no network, and no systemd. Uses only the Python standard library.

Exit code 0 means all checks passed; anything else prints a diagnostic and
fails. The adapter runs this via `npm run test:all`.
"""

import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALLER = os.path.join(REPO_DIR, "infra", "install.sh")


def run_installer(*args, expect=0):
    """Run `bash infra/install.sh <args>` and return (returncode, stdout)."""
    proc = subprocess.run(
        ["bash", INSTALLER, *args],
        cwd=REPO_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
