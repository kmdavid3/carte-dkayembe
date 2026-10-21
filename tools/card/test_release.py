"""Adversarial cases for bounded ZIP restore and release approval enforcement."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import release


class ApprovedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)


class ReleaseBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.approved = json.loads(release.POLICY.read_text(encoding="utf-8"))
        self.policy = self.folder / "policy.json"
        self.write_policy()
        self.override = patch.object(release, "POLICY", self.policy)
        self.override.start()
        self.addCleanup(self.override.stop)
        self.clock = patch.object(release, "datetime", ApprovedDateTime)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def write_policy(self):
        self.policy.write_text(json.dumps(self.approved), encoding="utf-8")

    def fixture(self, changes=None):
        entries = {name: b"fixture" for name in self.approved["runtime_files"]}
        entries[".nojekyll"] = b""
        manifest = {"files": [{"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                              for name, data in entries.items()]}
        if changes:
            changes(entries, manifest)
        archive = self.folder / "card.zip"
        with zipfile.ZipFile(archive, "w") as stream:
            for name, data in entries.items():
                stream.writestr(name, data)
        manifest_file = self.folder / "manifest.json"
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
        return argparse.Namespace(archive=str(archive), manifest=str(manifest_file), out=str(self.folder / "restored"))

    def test_valid_restore(self):
        args = self.fixture()
        release.restore(args)
        self.assertEqual(len([p for p in Path(args.out).rglob("*") if p.is_file()]), 11)

    def test_tampered_content_rejected(self):
        args = self.fixture(lambda entries, manifest: entries.update({"index.html": b"changed"}))
        with self.assertRaises(ValueError):
            release.restore(args)

    def test_traversal_rejected(self):
        args = self.fixture(lambda entries, manifest: entries.update({"../outside.txt": b"bad"}))
        with self.assertRaises(ValueError):
            release.restore(args)
        self.assertFalse((self.folder / "outside.txt").exists())

    def test_duplicate_archive_entry_rejected(self):
        args = self.fixture()
        with zipfile.ZipFile(args.archive, "a") as stream:
            stream.writestr("index.html", b"second")
        with self.assertRaises(ValueError):
            release.restore(args)

    def test_symlink_rejected(self):
        args = self.fixture()
        with zipfile.ZipFile(args.archive, "r") as original:
            data = {name: original.read(name) for name in original.namelist()}
        with zipfile.ZipFile(args.archive, "w") as stream:
            for name, content in data.items():
                info = zipfile.ZipInfo(name)
                if name == "index.html":
                    info.external_attr = 0o120777 << 16
                stream.writestr(info, content)
        with self.assertRaises(ValueError):
            release.restore(args)

    def test_expired_approval_rejected(self):
        self.approved["expires_at"] = "2000-01-01T00:00:00+00:00"
        self.write_policy()
        with self.assertRaises(ValueError):
            release.policy()

    def test_pending_approval_rejected(self):
        self.approved["status"] = "pending"
        self.write_policy()
        with self.assertRaises(ValueError):
            release.policy()

    def test_changed_destination_rejected(self):
        self.approved["repository"] = "other/destination"
        self.write_policy()
        with self.assertRaises(ValueError):
            release.policy()

    def test_expanded_runtime_rejected(self):
        self.approved["runtime_files"].append("private.txt")
        self.write_policy()
        with self.assertRaises(ValueError):
            release.policy()

    def test_extended_expiry_rejected(self):
        self.approved["expires_at"] = "2099-01-01T00:00:00+00:00"
        self.write_policy()
        with self.assertRaises(ValueError):
            release.policy()

    def test_changed_exception_rejected(self):
        self.approved["exception_id"] = "different-approval"
        self.write_policy()
        with self.assertRaises(ValueError):
            release.policy()

    def test_local_restore_survives_expiry_without_authorizing_publication(self):
        self.approved["expires_at"] = "2000-01-01T00:00:00+00:00"
        self.write_policy()
        args = self.fixture()
        release.restore(args)
        with self.assertRaises(ValueError):
            release.policy()


if __name__ == "__main__":
    unittest.main()
