#!/usr/bin/env python3
"""Contract checks for the isolated OpenSEO public info Worker."""

from __future__ import annotations

import json
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "deploy/oauth-info/public"
FIXTURE = ROOT / "deploy/oauth-info/copy-fixture.json"


class CopyParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict[str, str | None]] = []
        self.current: tuple[str, str | None, list[str]] | None = None
        self.anchor_in_paragraph = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"p", "h1", "h2", "a"}:
            href = dict(attrs).get("href") if tag == "a" else None
            self.current = (tag, href, [])
            if tag == "a":
                self.anchor_in_paragraph = True

    def handle_data(self, data: str) -> None:
        if self.current:
            self.current[2].append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.current and tag == self.current[0]:
            current_tag, href, parts = self.current
            text = "".join(parts).strip()
            if text and (current_tag != "p" or not self.anchor_in_paragraph):
                kind = "link" if current_tag == "a" else current_tag
                self.blocks.append({"kind": kind, "text": text, "href": href})
            self.current = None
            if tag == "a":
                self.anchor_in_paragraph = False


class OAuthInfoContractTests(unittest.TestCase):
    def test_worker_config_is_isolated_static_assets_only(self) -> None:
        raw = (ROOT / "deploy/oauth-info/wrangler.jsonc").read_text()
        uncommented = "\n".join(line for line in raw.splitlines() if not line.lstrip().startswith("//"))
        json_text = re.sub(r'("(?:[^"\\]|\\.)*")|,\s*(?=[}\]])', lambda token: token.group(1) or "", uncommented)
        config = json.loads(json_text)
        self.assertEqual(config["name"], "open-seo-selfhost-info")
        self.assertEqual(config["compatibility_date"], "2026-10-31")
        self.assertIs(config["workers_dev"], True)
        self.assertIs(config["preview_urls"], False)
        self.assertEqual(config["assets"], {
            "directory": "./public",
            "not_found_handling": "404-page",
            "html_handling": "auto-trailing-slash",
        })
        forbidden = {"main", "account_id", "vars", "services", "routes", "route", "kv_namespaces", "d1_databases", "r2_buckets"}
        self.assertFalse(forbidden.intersection(config))

    def test_public_copy_matches_fixed_golden_fixture(self) -> None:
        fixture = json.loads(FIXTURE.read_text())
        for page, html_path in (("home", PUBLIC / "index.html"), ("privacy", PUBLIC / "privacy/index.html")):
            parser = CopyParser()
            parser.feed(html_path.read_text())
            self.assertEqual(parser.blocks, fixture[page], page)

    def test_public_asset_inventory_and_no_active_dynamic_content(self) -> None:
        expected = {"index.html", "privacy/index.html", "styles.css", "404.html", "_headers"}
        actual = {str(path.relative_to(PUBLIC)) for path in PUBLIC.rglob("*") if path.is_file()}
        self.assertEqual(actual, expected)
        for path in PUBLIC.rglob("*.html"):
            source = path.read_text().lower()
            parser = CopyParser()
            parser.feed(source)
            self.assertNotIn("<script", source)
            self.assertNotIn("<form", source)
            self.assertNotIn("<iframe", source)
            self.assertNotIn("http://", source)
            self.assertNotIn("http://", source)
            for line in source.splitlines():
                if 'href="https://' in line and "seo.katot.dev" not in line and "myaccount.google.com" not in line and "workers.dev" not in line:
                    self.fail(f"Unexpected external dependency in {path}: {line}")

    def test_metadata_semantics_navigation_and_accessibility(self) -> None:
        expected = {
            PUBLIC / "index.html": ("https://open-seo-selfhost-info.draconiatk.workers.dev/", "自分のサイトの検索とアクセスを確認する"),
            PUBLIC / "privacy/index.html": ("https://open-seo-selfhost-info.draconiatk.workers.dev/privacy/", "プライバシーポリシー"),
        }
        for path, (canonical, title_text) in expected.items():
            source = path.read_text()
            self.assertIn('<html lang="ja">', source)
            self.assertIn('<meta name="viewport" content="width=device-width, initial-scale=1">', source)
            self.assertIn(f'<link rel="canonical" href="{canonical}">', source)
            self.assertIn("<title>", source)
            self.assertIn(title_text, source)
            self.assertEqual(source.count("<h1>"), 1)
            self.assertEqual(source.count("<main>"), 1)
            self.assertIn('href="/styles.css"', source)
            self.assertIn(":focus-visible", (PUBLIC / "styles.css").read_text())
        privacy = (PUBLIC / "privacy/index.html").read_text()
        self.assertEqual(privacy.count("<h2>"), 5)
        self.assertIn('href="https://myaccount.google.com/connections"', privacy)
        home = (PUBLIC / "index.html").read_text()
        self.assertIn('href="https://seo.katot.dev/"', home)
        self.assertIn('href="/privacy/"', home)
        self.assertIn('href="mailto:katot.vita@gmail.com"', home)

    def test_headers_and_real_404_document(self) -> None:
        headers = (PUBLIC / "_headers").read_text()
        for value in (
            "Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: strict-origin-when-cross-origin",
        ):
            self.assertIn(value, headers)
        self.assertNotIn("includeSubDomains", headers)
        not_found = (PUBLIC / "404.html").read_text()
        self.assertIn("404", not_found)
        self.assertIn("ページが見つかりません", not_found)
        self.assertIn('href="/"', not_found)
        self.assertNotIn("<script", not_found.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
