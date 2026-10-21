"""Smoke-test the restored card on an HTTP/OCI reference server."""
import argparse
import hashlib
from pathlib import Path
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--root", required=True)
args = parser.parse_args()
base = args.url.rstrip("/")
for attempt in range(20):
    try:
        with urllib.request.urlopen(base + "/healthz", timeout=3) as response:
            assert response.status == 200
            assert response.read() == b"ok\n"
        break
    except (OSError, AssertionError):
        if attempt == 19:
            raise
        time.sleep(1)
with urllib.request.urlopen(base + "/", timeout=5) as response:
    assert response.status == 200
    assert response.headers.get("X-Frame-Options") == "DENY"
    assert response.headers.get("X-Content-Type-Options") == "nosniff"
    assert response.headers.get("Referrer-Policy") == "no-referrer"
    assert "frame-ancestors 'none'" in response.headers.get("Content-Security-Policy", "")
    assert hashlib.sha256(response.read()).digest() == hashlib.sha256((Path(args.root) / "index.html").read_bytes()).digest()
try:
    urllib.request.urlopen(base + "/tools/card/security.py", timeout=5)
    raise AssertionError("Control source must not be served from the runtime image")
except urllib.error.HTTPError as error:
    assert error.code == 404
print('{"portable_http": "passed", "headers": "passed", "runtime_matches_release": true}')
