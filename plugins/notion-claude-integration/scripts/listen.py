#!/usr/bin/env python3
"""Notion webhook listener — mirrors the bun filter logic and prints everything to stdout."""

import hashlib
import hmac
import json
import os
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8788
SECRET = os.environ.get("NOTION_WEBHOOK_SECRET", "")
NOTION_TOKEN = os.environ.get("NOTION_FILTER_TOKEN", "")
NOTION_VERSION = "2022-06-28"

# Fetch the bot user ID so we can filter out our own comments by ID
BOT_USER_ID: str | None = None
if NOTION_TOKEN:
    try:
        req = urllib.request.Request(
            "https://api.notion.com/v1/users/me",
            headers={"Authorization": f"Bearer {NOTION_TOKEN}", "Notion-Version": NOTION_VERSION},
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            BOT_USER_ID = (data.get("bot") or {}).get("owner", {}).get("user", {}).get("id") or data.get("id")
            print(f"🤖 Bot user ID: {BOT_USER_ID}", flush=True)
    except Exception as e:
        print(f"⚠️  Could not fetch bot user ID: {e}", flush=True)


def is_own_author(authors: list) -> bool:
    if not authors:
        return False
    # Drop if all authors are non-person types
    if all(a.get("type") != "person" for a in authors):
        return True
    # Drop if all authors match our bot's user ID (internal integrations appear as person)
    if BOT_USER_ID and all(a.get("id") == BOT_USER_ID for a in authors):
        return True
    return False


def section(title: str):
    print(f"\n{'=' * 60}", flush=True)
    print(f"  {title}", flush=True)
    print('=' * 60, flush=True)


def fetch_page_properties(page_id: str) -> dict | None:
    section(f"📡 Notion API: GET /v1/pages/{page_id}")
    req = urllib.request.Request(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers={
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            print(f"✅ HTTP {resp.status}", flush=True)
            print(json.dumps(data, indent=2), flush=True)
            return data.get("properties")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"❌ HTTP {e.code}: {body}", flush=True)
        return None
    except Exception as e:
        print(f"❌ Request failed: {e}", flush=True)
        return None


def fetch_property_item(page_id: str, property_id: str, property_name: str) -> str | None:
    """Fetch a single property via the property item endpoint (needed for rollups)."""
    section(f"📡 Notion API: GET /v1/pages/{page_id}/properties/{property_id} ({property_name})")
    req = urllib.request.Request(
        f"https://api.notion.com/v1/pages/{page_id}/properties/{property_id}",
        headers={
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            print(f"✅ HTTP {resp.status}", flush=True)
            print(json.dumps(data, indent=2), flush=True)
            # Property item endpoint returns {"object": "list", "results": [...]} for rollups
            results = data.get("results") or []
            for item in results:
                val = get_property_value({"_": item}, "_")
                if val:
                    return val
            # Or a single property_item object
            val = get_property_value({"_": data}, "_")
            return val
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"❌ HTTP {e.code}: {body}", flush=True)
        return None
    except Exception as e:
        print(f"❌ Request failed: {e}", flush=True)
        return None


def get_property_value(props: dict, name: str) -> str | None:
    prop = props.get(name)
    if not prop:
        return None
    t = prop.get("type")
    if t == "status":
        return (prop.get("status") or {}).get("name")
    if t == "select":
        return (prop.get("select") or {}).get("name")
    if t == "url":
        return prop.get("url")
    if t == "rich_text":
        items = prop.get("rich_text") or []
        if isinstance(items, dict):  # property item endpoint returns a dict, not array
            return items.get("plain_text")
        return items[0].get("plain_text") if items else None
    if t == "title":
        items = prop.get("title") or []
        if isinstance(items, dict):
            return items.get("plain_text")
        return items[0].get("plain_text") if items else None
    if t == "rollup":
        # show_original rollups return an array of the underlying property objects
        for item in prop.get("rollup", {}).get("array") or []:
            val = get_property_value({"_": item}, "_")
            if val:
                return val
        return None
    return None


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))

        # Signature verification
        if SECRET:
            sig = self.headers.get("x-notion-signature", "")
            expected = "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                self._respond(401, "Unauthorized")
                print("❌ Invalid signature — rejected", flush=True)
                return

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, "Bad Request")
            print("❌ Non-JSON body", flush=True)
            return

        # Notion verification handshake
        if "verification_token" in parsed:
            self._respond(200, json.dumps({"verification_token": parsed["verification_token"]}),
                          content_type="application/json")
            print("🤝 Notion verification handshake — responded", flush=True)
            return

        event_type = parsed.get("type", "unknown")
        section(f"📨 Incoming: {event_type}")
        print(json.dumps(parsed, indent=2), flush=True)

        # --- Filter logic (mirrors webhook.ts) ---

        if event_type == "page.properties_updated":
            page_id = (parsed.get("entity") or {}).get("id")
            authors = parsed.get("authors") or []

            # Drop events authored by this integration (Claude's own writes)
            if is_own_author(authors):
                section("🚫 DROPPED — authored by this integration")
                self._respond(200, "Ignored")
                return

            # Fetch page and check Status + GitHub PR
            if page_id and NOTION_TOKEN:
                props = fetch_page_properties(page_id)
                if props is not None:
                    workflow = get_property_value(props, "Workflow")
                    github_pr = get_property_value(props, "GitHub PR")

                    # Rollups return empty arrays in the main page fetch — use property item endpoint
                    for prop_name in ("Project Folder", "GitHub Repo"):
                        prop = props.get(prop_name, {})
                        if prop.get("type") == "rollup" and not prop.get("rollup", {}).get("array"):
                            prop_id = prop.get("id", "")
                            val = fetch_property_item(page_id, prop_id, prop_name)
                            if val:
                                props[prop_name] = {"type": "rich_text", "rich_text": [{"plain_text": val}]}

                    section(f"🔍 Filter check")
                    print(f"  Workflow      : {workflow!r}", flush=True)
                    print(f"  GitHub PR     : {github_pr!r}", flush=True)
                    print(f"  Project Folder: {get_property_value(props, 'Project Folder')!r}", flush=True)
                    print(f"  GitHub Repo   : {get_property_value(props, 'GitHub Repo')!r}", flush=True)
                    if workflow == "In Progress" and not github_pr:
                        section("✅ WOULD FORWARD TO CLAUDE — implement-feature")
                    elif workflow == "Done":
                        section("✅ WOULD FORWARD TO CLAUDE — merge-deploy")
                    else:
                        section(f"🚫 DROPPED — Workflow={workflow!r}, GitHub PR={github_pr!r}")
                        self._respond(200, "Ignored")
                        return
            elif not NOTION_TOKEN:
                print("⚠️  NOTION_FILTER_TOKEN not set — skipping page fetch", flush=True)
                section("✅ WOULD FORWARD TO CLAUDE (no token to filter)")

        elif event_type == "comment.created":
            authors = parsed.get("authors") or []
            if is_own_author(authors):
                section("🚫 DROPPED — comment authored by this integration")
                self._respond(200, "Ignored")
                return
            section("✅ WOULD FORWARD TO CLAUDE")

        else:
            section(f"🚫 DROPPED — unhandled event type: {event_type!r}")
            self._respond(200, "Ignored")
            return

        self._respond(200, "OK")

    def _respond(self, status: int, body: str, content_type: str = "text/plain"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        pass  # suppress default access log noise


if __name__ == "__main__":
    if not SECRET:
        print("⚠️  NOTION_WEBHOOK_SECRET not set — skipping signature verification", flush=True)
    if not NOTION_TOKEN:
        print("⚠️  NOTION_FILTER_TOKEN not set — page fetch filter disabled", flush=True)

    print(f"🎧 Listening on http://127.0.0.1:{PORT}", flush=True)
    try:
        HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
        sys.exit(0)
