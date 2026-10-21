"""Build and restore the card's small, allowlisted static release. Python stdlib only."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

POLICY = Path(__file__).with_name("release-policy.json")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def policy(require_active=True):
    value = json.loads(POLICY.read_text(encoding="utf-8"))
    if value["exception_id"] != "EX-CARTE-PAGES-A2" or value["approved_on"] != "2026-10-21":
        raise ValueError("Release approval differs from the recorded owner decision")
    if value["status"] != "approved" or value["assurance_level"] != "A2":
        raise ValueError("Release approval is not active")
    expiry = datetime.fromisoformat(value["expires_at"])
    if expiry > datetime.fromisoformat("2026-11-20T23:59:59+01:00"):
        raise ValueError("Release approval must not be extended without a new owner decision")
    if require_active and (datetime.now(timezone.utc) < datetime.fromisoformat("2026-10-21T00:00:00+01:00") or datetime.now(timezone.utc) > expiry):
        raise ValueError("Release exception has expired; a new owner decision is required")
    if (value["repository"], value["branch"], value["url"]) != (
        "kmdavid3/carte-dkayembe", "gh-pages", "https://kmdavid3.github.io/carte-dkayembe/"
    ):
        raise ValueError("Publication destination differs from the approved scope")
    expected = {
        "index.html", "style.css", "app.js", "qr.js", ".nojekyll",
        "assets/sils-logo-signature.svg", "assets/sils-logo-signature.png",
        "assets/fonts/Manrope-variable-latin.woff", "assets/fonts/Manrope-OFL.txt",
        "assets/fonts/SourceSans3-variable-latin.woff", "assets/fonts/SourceSans3-OFL.txt",
    }
    if set(value["runtime_files"]) != expected or len(value["runtime_files"]) != len(expected):
        raise ValueError("Runtime allowlist differs from the reviewed eleven files")
    return value


def empty_output(directory):
    output = Path(directory).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output must be a new or empty directory")
    output.mkdir(parents=True, exist_ok=True)
    return output


def build(args):
    approved = policy()
    root = Path(args.root).resolve(strict=True)
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], text=True).strip()
    if dirty:
        raise ValueError("Release provenance requires a clean committed source tree")
    out = empty_output(args.out)
    site = out / "site"
    site.mkdir()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    committed = subprocess.check_output(["git", "show", "-s", "--format=%cI", "HEAD"], text=True).strip()
    entries = []
    for name in sorted(approved["runtime_files"]):
        source = root / name
        if name == ".nojekyll" and not source.exists():
            data = b""
        else:
            if source.is_symlink() or not source.resolve(strict=True).is_relative_to(root):
                raise ValueError("Symlink or external runtime file rejected")
            data = source.read_bytes()
        if len(data) > 2_000_000 or (name == ".nojekyll" and data):
            raise ValueError("Runtime file exceeds its allowed bounds")
        destination = site / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        entries.append({"path": name, "size": len(data), "sha256": digest(data)})
    manifest = {"schema_version": 1, "commit": commit, "source_date": committed,
                "exception_id": approved["exception_id"], "files": entries}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # Fixed timestamps and ordering make the ZIP reproducible for the same source bytes.
    with zipfile.ZipFile(out / "card.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in entries:
            info = zipfile.ZipInfo(item["path"], (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (site / item["path"]).read_bytes())
    zip_hash = digest((out / "card.zip").read_bytes())
    sbom_files = []
    for index, item in enumerate(entries):
        license_id = "OFL-1.1" if item["path"].startswith("assets/fonts/") else "NOASSERTION"
        sbom_files.append({"SPDXID": f"SPDXRef-File-{index}", "fileName": "./" + item["path"],
                           "checksums": [{"algorithm": "SHA256", "checksumValue": item["sha256"]}],
                           "licenseConcluded": license_id,
                           "licenseInfoInFiles": ["MIT" if item["path"] == "qr.js" else license_id],
                           "copyrightText": "Copyright (c) Project Nayuki (portions)" if item["path"] == "qr.js" else "NOASSERTION"})
    sbom = {"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
            "name": "SILS digital card runtime", "documentNamespace": f"https://spdx.org/spdxdocs/sils-card-{commit}",
            "creationInfo": {"created": datetime.fromisoformat(committed).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "creators": ["Tool: sils-card-release.py"]}, "files": sbom_files}
    (out / "sbom.spdx.json").write_text(json.dumps(sbom, indent=2) + "\n", encoding="utf-8")
    # Unsigned, inspectable provenance: no claim of attestation, signing or SLSA certification.
    provenance = {"_type": "https://in-toto.io/Statement/v1", "subject": [{"name": "card.zip", "digest": {"sha256": zip_hash}}],
                  "predicateType": "https://sils.example/provenance/static-release/v1",
                  "predicate": {"sourceCommit": commit, "repository": os.environ.get("GITHUB_REPOSITORY", "local"),
                                "buildCommand": "python tools/card/release.py build",
                                "invocation": os.environ.get("GITHUB_RUN_ID", "local"), "signed": False,
                                "manifestSha256": digest((out / "manifest.json").read_bytes())}}
    (out / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    sums = [f"{digest((out / name).read_bytes())}  {name}" for name in
            ["card.zip", "manifest.json", "sbom.spdx.json", "provenance.json"]]
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    portable_source = Path(__file__).resolve().parents[2] / "portable" / "card"
    portable_output = out / "portable"
    portable_output.mkdir()
    for name in ["Dockerfile", "nginx.conf"]:
        shutil.copyfile(portable_source / name, portable_output / name)
    shutil.copytree(site, portable_output / "site")
    print(json.dumps({"release_files": len(entries), "archive_sha256": zip_hash, "source_commit": commit}))


def restore(args):
    # Recovering a local backup does not authorize publication and remains possible after expiry.
    approved = policy(require_active=False)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    records = manifest["files"]
    names = [item["path"] for item in records]
    if len(names) != len(set(names)) or set(names) != set(approved["runtime_files"]):
        raise ValueError("Restore manifest is outside the reviewed runtime scope")
    out = empty_output(args.out)
    with zipfile.ZipFile(args.archive) as archive:
        members = archive.infolist()
        if len(members) != len(names) or {item.filename for item in members} != set(names):
            raise ValueError("Archive has missing, duplicate or unexpected entries")
        for record in records:
            name = record["path"]
            pure = PurePosixPath(name)
            info = archive.getinfo(name)
            if pure.is_absolute() or ".." in pure.parts or "\\" in name or info.file_size > 2_000_000:
                raise ValueError("Unsafe archive entry rejected")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Archive symlink rejected")
            data = archive.read(name)
            if len(data) != record["size"] or digest(data) != record["sha256"]:
                raise ValueError("Restored content hash mismatch")
            destination = out.joinpath(*pure.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
    print(json.dumps({"restored_files": len(names), "all_hashes_match": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("authorize")
    package = commands.add_parser("build")
    package.add_argument("--root", required=True)
    package.add_argument("--out", required=True)
    recover = commands.add_parser("restore")
    recover.add_argument("--archive", required=True)
    recover.add_argument("--manifest", required=True)
    recover.add_argument("--out", required=True)
    options = parser.parse_args()
    try:
        if options.command == "authorize":
            print(json.dumps({"active_approval": policy()["exception_id"]}))
        elif options.command == "build":
            build(options)
        else:
            restore(options)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(f"Release verification failed: {error}", file=sys.stderr)
        sys.exit(1)
