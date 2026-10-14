# Social: weekend carousel for @auecuritiba

"Rola esse fim de semana em Curitiba": a cover, one slide per event, and a closing slide that recruits Android beta testers ("Tem Android? Testa o auê antes de todo mundo — link na bio") and points iPhone users to the App Store. The script only renders files; a person reviews and posts them.

## Run

```bash
npm run social:weekend                                   # the coming Fri..Sun (America/Sao_Paulo)
npm run social:weekend -- --from 2026-10-16 --to 2026-10-18
npm run social:weekend -- --input feed.json --no-images  # offline: a saved /events response, no flyer thumbnails
npm run social:weekend -- --exclude <event id>,<event id> # drop picks by hand, then re-run
npm run test:social                                      # selection rules (node:test)
```

Output lands in `social/out/<from>/` (gitignored): `01-capa.png`, one PNG per event, the closing slide, `caption.txt`, `picks.json` (why each event was picked, what was filtered out) and `contact-sheet.png`. Rendering uses Playwright's Chromium; fonts come from Google Fonts once and are cached in `social/out/.cache/`.

Selection (`scripts/social/select.mjs`, pure and deterministic): events overlapping the window, real Curitiba events with an Instagram handle to credit; one-off events with a time and a venue handle first; at most 2 per type (`tipo`), 1 per venue, 1 multi-week run, 1 recurring, 1 kids event; at least 2 free and 2 paid when the feed has them; days taken round-robin, then shown by date and time.

## Before posting (every time)

- Open `contact-sheet.png`. The script exits with code 2 if any text leaves the safe margin, and lists clamped text (cut with "…") as warnings: read those slides.
- Check every pick on the venue's own profile: date, time, price and whether it still happens. The feed is scraped from Instagram and can be wrong (an out-of-town race geocoded onto a Curitiba bairro, a past date). Drop a bad one with `--exclude` and re-run.
- The pitch line is the feed's own text, only trimmed. If it reads off, exclude the event; do not rewrite it on the slide.
- Flyers appear only as a small thumbnail next to the "@handle" credit. If a venue asks, re-run with `--no-images`.
- Voice: casual and descriptive ("bora", "rola", "acontece"); never "recomendado", "baixa pressão", "introvertido", "ambiente acolhedor".
- Post from the @auecuritiba account (check the logged-in username), paste `caption.txt`, and tag each venue on its slide too: tagged venues are the ones that repost.

## Weekly rhythm

- **Thursday morning:** run it for the coming weekend, review, post Thursday between 18h and 20h.
- **Friday:** reshare the carousel to stories; repost the venues' stories that tagged us.
- **Monday:** look at reach, saves and which venues reposted; the Android beta sign-ups from the bio link are the number that counts.
