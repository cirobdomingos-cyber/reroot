"""
Tests for /.well-known/assetlinks.json (Android Digital Asset Links).

Context: main.py used to carry a second, hardcoded copy of this file in the
SPA fallback: package com.reroot.app and the fingerprint of a keystore whose
private key is public in git history. The env-driven route is the only
source now, and the fallback reuses it.

What must hold:
  1. With no TWA_SHA256_FINGERPRINT the endpoint answers [] (no verified app).
  2. With it set, the statement names TWA_PACKAGE_NAME (default app.aue)
     and that fingerprint only.
  3. The explicit route is the one Starlette matches first, ahead of the
     /{path:path} catch-all.
  4. The burned package/fingerprint appear nowhere in main.py.
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.delenv("TWA_SHA256_FINGERPRINT", raising=False)
    monkeypatch.delenv("TWA_PACKAGE_NAME", raising=False)

    def _boot(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        for mod in ("database", "main"):
            sys.modules.pop(mod, None)
        import database as _db
        import main as _main
        _db.init_db()
        from fastapi.testclient import TestClient
        return _main, TestClient(_main.app)

    return _boot


def test_empty_without_fingerprint(api):
    _, client = api()
    r = client.get("/.well-known/assetlinks.json")
    assert r.status_code == 200
    assert r.json() == []


def test_statement_uses_env_package_and_fingerprint(api):
    _, client = api(TWA_SHA256_FINGERPRINT=FP)
    body = client.get("/.well-known/assetlinks.json").json()
    assert len(body) == 1
    target = body[0]["target"]
    assert target["package_name"] == "app.aue"
    assert target["sha256_cert_fingerprints"] == [FP]


def test_explicit_route_is_matched_before_the_spa_fallback(api):
    from starlette.routing import Match

    main, _ = api()
    scope = {"type": "http", "path": "/.well-known/assetlinks.json", "method": "GET"}
    first = next(rt for rt in main.app.routes if rt.matches(scope)[0] == Match.FULL)
    assert first.endpoint is main.asset_links


def test_no_burned_package_or_fingerprint_in_main():
    src = (BACKEND / "main.py").read_text(encoding="utf-8")
    assert "com.reroot.app" not in src
    assert "4F:AA:60:AE" not in src
