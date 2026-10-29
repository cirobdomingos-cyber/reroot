"""
Put the Carnaval blocos into auê: track their Instagram handles and open
the channel that collects everything they post.

Context (29 Oct 2026): pré-Carnaval in Curitiba is already under way and
the blocos announce their saídas on Instagram, one account each. A
friend of the founder listed the 28 confirmed ones. Three "bloquinhos"
for kids (Bicibloquinho, Garibaldinhos, Siribloquinho) had no confirmed
handle and are left out — add them through /admin/ig-accounts once they
exist.

Two things make this cheaper than a regular venue:

  caption_only  The blocos agreed to write date, place and time in the
                caption, so the scrape judges the caption alone and never
                fetches the flyer (~2.2k tokens per slide). Per handle,
                so one that keeps posting flyer-only can be flipped back
                in the admin screen without touching the rest.
  rule          The channel fills by source category ("bloco"), not by
                tipo or genre: the model files a bloco as festa, show or
                outro depending on the caption, and the handle's category
                is a fact we wrote ourselves.

Idempotent: handles are upserted, the channel is created once (matched
by name) and its rule rewritten. Every step goes through the API as the
founder, so what it does is exactly what the admin screens can do.

The API reads the caller from a session: pass the bearer token the app
keeps in localStorage under `aue.session` (DevTools → Application).

Usage:
    py -3.12 scripts/import_blocos.py --base-url https://<env>.up.railway.app \\
        --email <founder email> --token <session token> [--dry-run]
"""
import argparse
import json
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

# Windows consoles default to cp1252, which can't print the names below.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CATEGORY = "bloco"

CHANNEL = {
    "name": "auê Carnaval",
    "description": "Todos os blocos do pré-Carnaval e do Carnaval de Curitiba, "
                   "direto do Instagram de cada um. Concentração, saída e percurso.",
}

# (label, handle) — from "Blocos_Curitiba_Instagram_And - 27/10/2026".
BLOCOS = [
    ("Afro Pretinhosidade", "blocoafropretinhosidadeoficial"),
    ("Astrobloco", "astro.bloco"),
    ("Backstreet Bloco", "backstreet.bloco"),
    ("Baque Mulher Curitiba", "baquemulhercwb"),
    ("Batucannabis", "batucannabis"),
    ("Bicibloco", "bicibloco"),
    ("Bloca Ela Pode, Ela Vai", "elapodeelavai"),
    ("Bloco Brasilidades", "brasilidadess"),
    ("Bloco Burlesco Cachorras", "bbcachorras"),
    ("Bloco de Pífanos de Curitiba", "blocodepifanoscwb"),
    ("Bloco de Segunda", "blocodesegunda"),
    ("Bloco dos Blocos", "blocodosblocos"),
    ("Bloco Ecoorquestra", "ecoorquestra"),
    ("Bloco Secreto Curitiba", "blocosecreto.curitiba"),
    ("Bocas Malditas", "bocasmalditas"),
    ("Caiu no Cavalo Babão", "caiunocavalobabao"),
    ("Carreta SapaPan Bi Bi", "carretasapapanbibi"),
    ("Cordão da Trupe Guará", "trupeguara"),
    ("Devagar & Sempre", "devagaresemprecwb"),
    ("Garibaldis & Sacis", "garibaldisesacis"),
    ("Malinski-se", "blocomalinski_se"),
    ("Maracatu Aroeira", "maracatuaroeira"),
    # The profile is Juana Profunda's, who leads the march.
    ("Marcha das 1000 Drags", "juana.profunda"),
    ("Marginais", "bloco_marginais"),
    ("O Amor é Brega", "blocooamorebrega"),
    ("Saí do Armário e Me Dei Bem", "saidoarmarioemedeibem"),
    ("Segura o CUritiba", "seguraocuritiba"),
    ("Siribloco", "siribloco"),
]


def _norm(name: str) -> str:
    folded = unicodedata.normalize("NFKD", name or "")
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return folded.casefold().replace("aue ", "").strip()


class Api:
    def __init__(self, base_url: str, email: str, token: str, dry_run: bool):
        self.base = base_url.rstrip("/")
        self.email = email
        self.token = token
        self.dry_run = dry_run

    def _call(self, method: str, path: str, body: dict | None = None):
        """One request as the founder. A non-2xx stops the script."""
        url = f"{self.base}{path}"
        if method == "GET":
            url += "?" + urllib.parse.urlencode({"requesting_email": self.email})
        if self.dry_run and method != "GET":
            print(f"  [dry-run] {method} {path} {json.dumps(body, ensure_ascii=False) if body else ''}")
            return {}
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            sys.exit(f"{method} {path} -> {exc.code}: {detail}")

    def upsert_account(self, handle: str, label: str) -> dict:
        return self._call("POST", "/admin/ig-accounts", {
            "requesting_email": self.email, "handle": handle, "label": label,
            "category": CATEGORY, "enabled": True, "caption_only": True,
            "notes": "Carnaval 2027 — legenda traz data/local/horário",
        })

    def channels(self) -> dict[str, dict]:
        return {_norm(c["name"]): c for c in self._call("GET", "/channels")["channels"]}

    def create_channel(self) -> dict:
        return self._call("POST", "/admin/channels", {
            "requesting_email": self.email, **CHANNEL,
            "rule_tipos": [], "rule_genres": [], "rule_categories": [CATEGORY],
        })

    def set_rule(self, cid: str) -> dict:
        return self._call("PUT", f"/channels/{cid}", {
            "requesting_email": self.email, "rule_categories": [CATEGORY],
        })


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--email", required=True, help="founder email")
    ap.add_argument("--token", default="", help="session bearer token (aue.session in the app)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    api = Api(args.base_url, args.email, args.token, args.dry_run)

    # 1. Handles first: the channel's rule is validated against the
    #    categories tracked handles actually carry, so "bloco" has to
    #    exist before a channel can ask for it.
    print(f"Tracking {len(BLOCOS)} blocos as category '{CATEGORY}', caption-only:")
    for label, handle in BLOCOS:
        api.upsert_account(handle, label)
        print(f"  @{handle:<34} {label}")

    # 2. The channel, once. Rewriting the rule on an existing channel
    #    fills it now rather than at the next scrape.
    existing = api.channels().get(_norm(CHANNEL["name"]))
    if existing:
        res = api.set_rule(existing["id"])
        print(f"Channel '{CHANNEL['name']}' already exists — rule set, {res.get('added', 0)} events added")
    else:
        res = api.create_channel()
        print(f"Channel '{CHANNEL['name']}' created, {res.get('added', 0)} events added")
    print("Done. The next scrape picks up what the blocos post; "
          "a manual scrape per handle is in /admin/ig-accounts.")


if __name__ == "__main__":
    main()
