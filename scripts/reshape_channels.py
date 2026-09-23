"""
Reshape the auê channels to fit what the catalog actually holds — and
hand each one the rule the scrape fills it by from now on.

Measured 23 Sep 2026 on production (167 upcoming events):

    festa/balada 40 · show 40 · comédia 17 · gastronomia 15 ·
    corrida 13 · literatura 13 · teatro 8 · kids 7 · exposição 5

against eight hand-filled channels, of which Comédia didn't exist,
Cultura held four kinds of night at once, and MPB and Jazz had two and
three events each. The plan this script applies:

    keep + rule   Rock (genre rock), Eletrônica (genre eletronica),
                  Samba e Pagode (genre samba_pagode),
                  Gastronomia (tipo gastronomia, feira)
    create        Comédia (tipo comedia), Livros (tipo literatura)
    narrow        Cultura → tipo teatro, cinema, exposicao, oficina
    merge         Balada → Eletrônica (its six nights were Club Vibe)
                  MPB → Jazz e Blues, renamed "MPB & Jazz"
                  (genre mpb, jazz_blues)

Idempotent: run it twice and the second run changes nothing. Every step
goes through the API as the founder, so what it does is exactly what the
admin screens can do — nothing here reaches into the database.

Usage:
    py -3.12 scripts/reshape_channels.py --base-url https://<env>.up.railway.app \\
        --email <founder email> [--dry-run]
"""
import argparse
import json
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

# Windows consoles default to cp1252, which can't print the names above.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Target state, keyed by the channel's display name. `was` lists the
# names an existing channel may carry that should become this one
# (rename), `merge` the channels folded into it (deleted afterwards).
PLAN = [
    {"name": "auê Rock", "genres": ["rock"], "was": ["auê Rockzera"],
     "description": "Curadoria auê de rock em Curitiba."},
    {"name": "auê Eletrônica", "genres": ["eletronica"], "merge": ["auê Balada"],
     "description": "Curadoria auê de pista e música eletrônica em Curitiba."},
    {"name": "auê Samba e Pagode", "genres": ["samba_pagode"],
     "description": "Curadoria auê de samba e pagode em Curitiba."},
    {"name": "auê MPB & Jazz", "genres": ["mpb", "jazz_blues"],
     "was": ["auê Jazz e Blues"], "merge": ["auê MPB"],
     "description": "Curadoria auê de MPB, jazz e blues em Curitiba."},
    {"name": "auê Comédia", "tipos": ["comedia"],
     "description": "Stand-up, improviso e comédia em Curitiba. Toda noite tem."},
    {"name": "auê Cultura", "tipos": ["teatro", "cinema", "exposicao", "oficina"],
     "description": "Teatro, cinema, exposições e oficinas em Curitiba."},
    {"name": "auê Livros", "tipos": ["literatura"],
     "description": "Lançamentos, saraus e clubes do livro em Curitiba."},
    {"name": "auê Gastronomia", "tipos": ["gastronomia", "feira"],
     "description": "Festivais, feiras e degustações em Curitiba."},
]


def _norm(name: str) -> str:
    folded = unicodedata.normalize("NFKD", name or "")
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return folded.casefold().replace("aue ", "").strip()


class Api:
    def __init__(self, base_url: str, email: str, dry_run: bool):
        self.base = base_url.rstrip("/")
        self.email = email
        self.dry_run = dry_run

    def _call(self, method: str, path: str, body: dict | None = None,
              query: dict | None = None, fatal: bool = True):
        """One request as the founder. A non-2xx stops the script unless
        `fatal` is off, in which case it comes back as {"error": ...}."""
        q = dict(query or {})
        if method != "GET":
            q.setdefault("requesting_email", self.email)
        url = f"{self.base}{path}" + (f"?{urllib.parse.urlencode(q)}" if q else "")
        if self.dry_run and method != "GET":
            print(f"  [dry-run] {method} {path} {json.dumps(body, ensure_ascii=False) if body else ''}")
            return {}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            if not fatal:
                return {"error": f"{exc.code}: {detail}"}
            sys.exit(f"{method} {path} -> {exc.code}: {detail}")

    def channels(self) -> dict[str, dict]:
        return {_norm(c["name"]): c for c in self._call("GET", "/channels")["channels"]}

    def create(self, name, description, tipos, genres):
        return self._call("POST", "/admin/channels", {
            "requesting_email": self.email, "name": name, "description": description,
            "rule_tipos": tipos, "rule_genres": genres,
        })

    def update(self, cid, **fields):
        return self._call("PUT", f"/channels/{cid}", {"requesting_email": self.email, **fields})

    def merge(self, source_id, target_id):
        return self._call("POST", f"/admin/channels/{source_id}/merge-into/{target_id}")

    def backfill(self, field):
        # Not fatal: staging runs without an Anthropic key and answers
        # 503 here. The rules then match only what's already tagged,
        # which is still a valid (if thinner) reshape.
        return self._call("POST", f"/admin/events/backfill-{field}",
                          query={"limit": 500}, fatal=False)

    def rebalance(self):
        return self._call("POST", "/admin/channels/rebalance")

    def fill(self):
        return self._call("POST", "/admin/channels/fill")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--email", required=True, help="founder email")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    api = Api(args.base_url, args.email, args.dry_run)

    # 1. Tags first: a rule can only match what's tagged, and every event
    #    scraped before `tipo` existed has none. The scrape does this
    #    daily from now on; this is the first pass.
    print("1. Backfilling tags on upcoming events")
    for field in ("tipo", "genre"):
        print(f"   {field}: {api.backfill(field)}")

    # 2. Renames, then rules — create what's missing, and a created
    #    channel opens full (the API fills it on POST).
    print("2. Channels and rules")
    existing = api.channels()
    for spec in PLAN:
        key = _norm(spec["name"])
        ch = existing.get(key)
        if not ch:
            for old in spec.get("was", []):
                ch = existing.pop(_norm(old), None)
                if ch:
                    print(f"   rename  {ch['name']} -> {spec['name']}")
                    api.update(ch["id"], name=spec["name"])
                    break
        rules = {"rule_tipos": spec.get("tipos", []), "rule_genres": spec.get("genres", [])}
        if ch:
            same = (ch.get("rule_tipos") == rules["rule_tipos"]
                    and ch.get("rule_genres") == rules["rule_genres"]
                    and ch.get("description") == spec["description"])
            if same:
                print(f"   ok      {spec['name']}")
            else:
                r = api.update(ch["id"], description=spec["description"], **rules)
                print(f"   rule    {spec['name']}  {rules}  +{r.get('added', 0)}")
            existing[key] = ch
        else:
            r = api.create(spec["name"], spec["description"],
                           rules["rule_tipos"], rules["rule_genres"])
            existing[key] = r.get("channel", {"id": "?", "name": spec["name"]})
            print(f"   create  {spec['name']}  {rules}  +{r.get('added', 0)}")

    # 3. Merges: followers, events and exclusions move; the source goes.
    print("3. Merges")
    for spec in PLAN:
        target = existing.get(_norm(spec["name"]))
        for old in spec.get("merge", []):
            src = existing.pop(_norm(old), None)
            if src and target and src["id"] != target["id"]:
                r = api.merge(src["id"], target["id"])
                print(f"   merge   {old} -> {spec['name']}  {r}")
            else:
                print(f"   ok      {old} already gone")

    # 4. Move what sat in the wrong channel (Cultura's comedy nights →
    #    Comédia), then fill everything that now matches.
    print("4. Rebalance:", api.rebalance())
    print("5. Fill:", api.fill())

    print("\nChannels now:")
    for c in sorted(api.channels().values(), key=lambda c: c["name"]):
        print(f"   {c['name']:<22} upcoming={c.get('upcoming_event_count', '?'):<3} "
              f"followers={c.get('follower_count', '?'):<3} "
              f"tipos={c.get('rule_tipos')} genres={c.get('rule_genres')}")


if __name__ == "__main__":
    main()
