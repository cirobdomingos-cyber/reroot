# Social: carousels for @auecuritiba

Two carousels, rendered from code; a person reviews and posts them.

- **Weekend list** (`npm run social:weekend`): "Rola esse fim de semana em Curitiba", a cover, one slide per event and a closing "Baixa o auê" slide (iPhone: App Store, Android: beta).
- **App tour** (`npm run social:tour`): "O que é o auê?", real screenshots of auecuritiba.com in a phone frame, one per feature, plus the same closing slide. Options: `--day Dom` (day selected in the list), `--event "Renato Russo"` (card opened for the detail screen). Output in `social/out/app-tour/`.

- **Canais** (`npm run social:channels`): "Segue um canal, recebe o fim de semana dele", a cover with every public channel, one slide per channel (up to 3 of its events in the window, "+N no canal", "segue no app") and the same closing slide. Selection in `scripts/social/channel-select.mjs`: repeated posts of one night count once (same place under 2h apart or sharing a name word; any place within 1h sharing 2+ words), a night in two channels goes to the smaller one, evenings first and days spread, channels with under 2 events get no slide. `--exclude id,id` as below, `--order "MPB & Jazz,Rock"` puts those slides first, `--featured 4` gives 4 channels their own slide and the rest one "Mais canais" slide, `--first <event id>` lists that event first on its slide, `--credit <event id>=<handle>` credits the venue when the scrape came from an agenda or ticket account; output in `social/out/channels-<from>/`.

Rules for all three (Ciro, 2026-10-14): no price and no "grátis / de graça" about events (the feed's values are guesses from flyers; the tour hides the "Custo" row); no "Bora porque" lines; the app is named on every slide ("link na bio"), not only on the last one.

## Run

```bash
npm run social:weekend                                   # the coming Fri..Sun (America/Sao_Paulo)
npm run social:weekend -- --from 2026-10-16 --to 2026-10-18
npm run social:weekend -- --input feed.json --no-images  # offline: a saved /events response, no flyer thumbnails
npm run social:weekend -- --exclude <event id>,<event id> # drop picks by hand, then re-run
npm run test:social                                      # selection rules (node:test)
```

Output lands in `social/out/<from>/` (gitignored): `01-capa.png`, one PNG per event, the closing slide, `caption.txt`, `picks.json` (why each event was picked, what was filtered out) and `contact-sheet.png`. Rendering uses Playwright's Chromium; fonts come from Google Fonts once and are cached in `social/out/.cache/`.

Selection (`scripts/social/select.mjs`, pure and deterministic): events overlapping the window, real Curitiba events with an Instagram handle to credit; one-off events with a time and a venue handle first; at most 2 per type (`tipo`), 1 per venue, 1 multi-week run, 1 recurring, 1 kids event; days taken round-robin, then shown by date and time.

## Before posting (every time)

- Open `contact-sheet.png`. The script exits with code 2 if any text leaves the safe margin, and lists clamped text (cut with "…") as warnings: read those slides.
- Check every pick on the venue's own profile: date, time and whether it still happens. The feed is scraped from Instagram and can be wrong (an out-of-town race geocoded onto a Curitiba bairro, a past date). Drop a bad one with `--exclude` and re-run.
- The description line is the feed's own text (vibeSummary first), only trimmed; text that names a price, a free entry or attendance is skipped. If it reads off, exclude the event; do not rewrite it on the slide.
- Flyers appear only as a small thumbnail next to the "@handle" credit. If a venue asks, re-run with `--no-images`.
- Voice: casual and descriptive ("bora", "rola", "acontece"), Brazilian "você / seu", never "tu / teu / tua" (reads as Portugal; Ciro, 2026-10-16); never "recomendado", "baixa pressão", "introvertido", "ambiente acolhedor".
- Post from the @auecuritiba account (check the logged-in username), paste `caption.txt`, and tag each venue on its slide too: tagged venues are the ones that repost.

## Weekly rhythm

- **Thursday morning:** run it for the coming weekend, review, post Thursday between 18h and 20h.
- **Friday:** reshare the carousel to stories; repost the venues' stories that tagged us.
- **Monday:** look at reach, saves and which venues reposted; the Android beta sign-ups from the bio link are the number that counts.
