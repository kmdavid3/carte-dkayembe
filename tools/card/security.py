"""Bounded checks for this static app; supplements independent review, not a general SAST audit."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.request
from html.parser import HTMLParser
from release import policy


class EmailParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.email = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and attrs.get("data-field") == "email":
            self.email = attrs.get("href", "")


def local(root):
    approval = policy()
    files = subprocess.check_output(["git", "ls-files", "-z"], text=False).split(b"\0")
    patterns = [rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
                rb"\bgh[pousr]_[A-Za-z0-9]{36,255}\b", rb"\bgithub_pat_[A-Za-z0-9_]{40,255}\b",
                rb"\bAKIA[0-9A-Z]{16}\b", rb"https?://[^\s/:'\"]+:[^\s/@'\"]+@"]
    scanned = 0
    for raw in files:
        if not raw:
            continue
        target = Path(raw.decode("utf-8"))
        if target.is_symlink() or not target.is_file():
            raise ValueError("Tracked symlink or missing file rejected")
        data = target.read_bytes()
        if b"\0" in data:
            continue
        scanned += 1
        if any(re.search(pattern, data) for pattern in patterns):
            raise ValueError(f"Potential secret requires review in {target.as_posix()}")
    for name in ["app.js", "qr.js"]:
        source = (root / name).read_text(encoding="utf-8")
        for pattern in [r"\beval\s*\(", r"\bnew\s+Function\s*\(", r"\bdocument\.write\s*\(",
                        r"\bfetch\s*\(", r"\bXMLHttpRequest\b"]:
            if re.search(pattern, source):
                raise ValueError(f"Unexpected runtime execution/network sink in {name}")
        subprocess.run(["node", "--check", str(root / name)], check=True)
    qr = (root / "qr.js").read_text(encoding="utf-8")
    if "Copyright (c) Project Nayuki" not in qr or "Permission is hereby granted" not in qr:
        raise ValueError("Attributed QR portions must retain their license notice")
    markup = (root / "index.html").read_text(encoding="utf-8")
    if re.search(r"<script\b(?![^>]*\bsrc=)[^>]*>\s*\S", markup, re.I):
        raise ValueError("Executable inline script rejected")
    if re.search(r"\son[a-z]+\s*=", markup, re.I):
        raise ValueError("Inline event handler rejected")
    for directive in ["default-src 'none'", "script-src 'self'", "base-uri 'none'", "form-action 'none'"]:
        if directive not in markup:
            raise ValueError("Expected restrictive CSP directive missing")
    for license_file in ["assets/fonts/Manrope-OFL.txt", "assets/fonts/SourceSans3-OFL.txt"]:
        if "SIL OPEN FONT LICENSE" not in (root / license_file).read_text(encoding="utf-8"):
            raise ValueError("Font license notice missing")
    print(json.dumps({"text_files_scanned": scanned, "runtime_static_checks": "passed", "approval": approval["exception_id"]}))


def live(root):
    approved = policy()
    url = approved["url"]
    request = urllib.request.Request(url, headers={"User-Agent": "SILS-card-health-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200 or response.url.rstrip("/") != url.rstrip("/"):
            raise ValueError("Unexpected public response or redirect")
        if "text/html" not in response.headers.get("Content-Type", ""):
            raise ValueError("Unexpected public MIME type")
        if not response.headers.get("Strict-Transport-Security"):
            raise ValueError("Public HSTS header missing")
        data = response.read(500_001)
        if len(data) > 500_000:
            raise ValueError("Public page exceeds its bounded expected size")
    expected = EmailParser()
    actual = EmailParser()
    expected.feed((root / "index.html").read_text(encoding="utf-8"))
    actual.feed(data.decode("utf-8"))
    if not expected.email or actual.email != expected.email:
        raise ValueError("Published contact email differs from the reviewed source")
    for resource in ["app.js", "qr.js", "style.css", "assets/sils-logo-signature.svg"]:
        with urllib.request.urlopen(url + resource, timeout=30) as response:
            if response.status != 200:
                raise ValueError("Public resource unavailable")
    print(json.dumps({"public_https": "passed", "published_contact": "matches", "resources": "available"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    try:
        (live if args.live else local)(Path(args.root).resolve(strict=True))
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Card security check failed: {error}", file=sys.stderr)
        sys.exit(1)
