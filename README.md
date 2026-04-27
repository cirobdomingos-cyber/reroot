# auê

**Curitiba que acontece.** Catálogo completo de eventos da cidade — shows, exposições, feiras, oficinas, encontros pequenos — agregado de Sympla, Eventbrite, MON, SESC, Catraca Livre e Instagram, com a camada social que falta nas plataformas existentes: você vê o que **a sua galera** vai junto.

Demo ao vivo: [reroot-production.up.railway.app](https://reroot-production.up.railway.app)

> *Renomeado em abril/2026 — antes chamado **Reroot**. O repositório e o subdomínio Railway ainda usam o nome antigo; manifest, ícones, copy e voz do produto já migraram pra auê.*

---

## The Problem

Achar o que está rolando em Curitiba neste fim de semana é uma caça ao tesouro entre uma dezena de apps e centenas de perfis no Instagram. Sympla mostra shows pagos; Eventbrite mostra eventos corporativos; o museu tem o site dele; o café que você gosta só posta no Instagram. Não existe um lugar único que agregue **tudo** o que está acontecendo na cidade — e os que tentam (Catraca Livre, agenda da prefeitura) são dominados por shows grandes ou listagens institucionais.

auê preenche essa lacuna. **É o catálogo que você queria que existisse**: feed único com tudo o que rola em Curitiba e filtros pra achar o que cabe em 10 segundos.

---

## What auê Does

**1. Um catálogo, várias fontes**

auê agrega continuamente eventos de:

- **Sympla** + **Eventbrite** — plataformas de bilhete pago (shows, oficinas, cursos)
- **MON, SESC Paraná, Teatro Guaíra, Turismo Curitiba** — agendas culturais institucionais
- **Catraca Livre** — agregador de eventos gratuitos / baixo custo
- **Instagram** (via Apify) — onde venues pequenos, cafés, curadores e coletivos publicam coisas que nunca chegam ao Sympla
- **auê Originals** — sugestões evergreen pra venues que não publicam eventos mas estão sempre abertos (Jardim Botânico, Café com Jogos, etc.) — atualmente 12

**2. Catálogo amplo + filtros duros**

Tudo o que é parte da vida cultural/social/recreativa de Curitiba entra: shows grandes, festivais, baladas, exposições, oficinas, esportes, feiras, encontros pequenos. Filtros duros (sempre aplicados) descartam ruído: eventos fora da Região Metropolitana, virtuais/online, networking corporativo, treinamento técnico, ritual religioso fechado, captação disfarçada (MLM, "palestra grátis" que vira gancho de curso).

**3. Enriquecimento via LLM**

Cada evento bruto passa pelo Claude Haiku, que extrai categoria, vibe, faixa de preço, tamanho esperado e um `pitch` de 1 linha em pt-BR ("Bora porque..."). Eventos sem detalhe suficiente são descartados, não inventados. Voz festiva, não terapêutica — sem moralismo, sem julgar a vibe.

**4. Camada social opcional**

Login Google, RSVP, lista de amigos, grupos privados, exportar pro calendário (.ics + Google Calendar), notificação push de lembrete e reconnect pós-evento. Tudo opcional — o catálogo funciona sem conta. Os chips de "amigos vão", "mesma noite que [outro evento seu]" e "mesmo lugar que [outro evento seu]" só aparecem quando você está logado e tem RSVPs.

---

## Why This Is Hard to Copy

As peças técnicas (React + FastAPI + Apify + Claude) são commodity. O defensável é a **pipeline de dados + camada editorial**:

- A lista de Instagram é curada à mão (~50 contas) — competidor teria que reconstruir do zero
- O prompt do Claude codifica um ponto de vista específico do que vale surfacear em Curitiba
- As regras duras de exclusão (cidades fora da RMC, grupos esotéricos fechados, eventos virtuais disfarçados, networking) são resultado de dezenas de iterações de falsos positivos

Essa curadoria é o que faz o usuário falar "esse app realmente tem os eventos que eu quero" em vez de "isso é o Sympla com busca pior".

---

## Tech Stack

| Camada | Stack |
|---|---|
| Frontend | React 18 + Vite + Framer Motion (PWA via `vite-plugin-pwa`) |
| Mobile | TWA via PWABuilder (Android/Play Store), Safari "Adicionar à Tela de Início" (iOS) |
| Backend | FastAPI (Python 3.12) on Railway |
| Database | SQLite (dev + prod, com volume Railway) |
| Scraping | httpx + BeautifulSoup, [Apify](https://apify.com) pro Instagram |
| LLM enrichment | Claude Haiku 4.5 (Anthropic API) |
| Venue data | Google Places API (Nearby Search) |
| Auth | Google Identity Services (OAuth) |
| Notifications | Web Push API (VAPID) + Capacitor Local Notifications |
| State | useReducer + localStorage (offline-first) |
| Service Worker | Workbox via `injectManifest` — precaching + push handler + navigation denylist pra rotas server-side (`/ios`, `/privacy`, `/.well-known/`) |
| Deploy | Railway (single-service multi-stage Docker: FastAPI serve o build do React) |
| CI | GitHub Actions: auto-merge `main → dev` mantém staging em sync com prod |

---

## Architecture

**Offline-first** — `src/services/api.js` sempre começa de dados embutidos, tenta o backend com timeout de 5s, e cai pra fallback silenciosamente. App funciona sem backend.

**Single-service deploy** — FastAPI serve o build do React em `/static`. Sem hosting de frontend separado, sem complexidade de CORS em produção, uma pipeline de deploy.

**Pipeline de eventos em 3 estágios:**
```
[10+ scrapers — Sympla, Eventbrite, SESC, MON, Turismo Curitiba, Catraca Livre, Instagram via Apify, ...]
    ↓ raw events com texto bagunçado e campos faltando
[Enriquecimento via Claude Haiku]
    ↓ structured event com category, vibe, price_tier, pitch ("Bora porque..."), is_curated
[API-time filters: regional, deny-list de conteúdo, dedup]
    ↓
[Frontend: catálogo amplo na tela Eventos, "amigos vão" + chips de personalização per-user no card]
```

**Personalização sem inflar custo de LLM** — pattern "shared content + per-user signals":
- LLM enriquece **uma vez por evento** (atributos: kind, vibe, pitch, etc.) → todos os usuários veem o mesmo texto
- Personalização **per-user** acontece no render via queries SQL/regras (amigos vão, RSVPs em conflito, mesmo lugar) → instantâneo, $0 extra
- Reservar LLM per-user só pra superfícies de alto valor (chat) — ainda não em produção

---

## Instagram Pipeline (the goldmine)

A maioria do que faz a cena social de Curitiba interessante — saraus pequenos, clubes de leitura de bairro, oficinas de nicho, yoga no parque — nunca aparece no Sympla. Vive no Instagram.

auê usa o **scraper hosted do [Apify](https://apify.com)** pra puxar posts recentes de uma lista curada de ~50 contas de Curitiba (museus, cafés, curadores, coletivos). Pra cada post, o Claude decide "isso é evento futuro em Curitiba com data?" e ou extrai campos estruturados ou pula. O yield é ~5–15% dos posts por scrape, mas esses eventos são exatamente os que o Sympla não tem.

Por que Apify e não scraping próprio: Instagram bloqueia agressivamente acesso anônimo e bane contas de teste em dias. Apify mantém infra de scraping (proxies, rotação de conta, anti-bot); pagamos $3–10/mês na nossa escala. Production-grade, TOS-aware, sem account babysitting.

UI admin em [`/admin/ig`](https://reroot-production.up.railway.app/admin/ig) pra adicionar, marcar, ativar/desativar e remover contas. Tempo do último scrape e yield de cada conta são trackados, então é fácil identificar contas que produzem ruído e podar.

---

## Closed Beta Distribution (atual)

**Android — TWA via PWABuilder:**
- `pwabuilder.com` aponta pra `https://reroot-production.up.railway.app` → gera AAB assinado
- Backend serve `/.well-known/assetlinks.json` validando o domínio (env var `TWA_SHA256_FINGERPRINT`)
- Upload no Play Console **Internal Testing track** (até 100 testers, sem App Review)
- URL bar fica oculta pelo TWA — UX igual app nativo

**iOS — Safari "Adicionar à Tela de Início":**
- Sem App Store por enquanto (custos: $99/ano + Mac obrigatório + risco de rejeição na Review)
- Página `/ios` com walkthrough visual em 3 passos, detecta WhatsApp/Chrome in-app browsers e avisa pra abrir no Safari
- Quando o app provar tração, migrar pra Capacitor + TestFlight (passa a App Review com folga)

**Política de privacidade**: `/privacy` (LGPD-compliant, pt-BR, exigida pelo Play Console e App Store).

---

## Monetization

Não cobra do usuário. Receita vem do supply side:

**Parcerias com venues** — bares, cafés e ateliês locais pagam R$300–500/mês por placement em destaque + selo "⭐ Parceiro auê". Pitch: "exibido a quem está ativamente procurando o que fazer, filtrado por bairro e vibe, ranqueado acima do ruído."

**Listagem de organizadores** — oficinas, cursos, festivais pagam R$150–300 por evento por placement curado com framing do auê.

**Cohorts corporativos** — empresas com times remotos/híbridos compram acesso de cohort pra recém-contratados se mudando pra Curitiba. Por seat, B2B.

Catálogo amplo (todo mundo usa) é o que torna a monetização defensável — placement pago só importa se os usuários já estão buscando ali.

---

## Local Development

```bash
# Frontend
npm install
npm run dev          # http://localhost:5173

# Backend (em outro terminal)
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Variáveis de ambiente (criar `backend/.env`):
```
ANTHROPIC_API_KEY=your_key       # obrigatório pro enrichment + extração Instagram
APIFY_API_TOKEN=apify_api_xxx    # obrigatório pra pipeline Instagram
GOOGLE_PLACES_API_KEY=your_key   # opcional — habilita seção Bares & Cafés
TWA_SHA256_FINGERPRINT=AB:CD:... # opcional — preenche /.well-known/assetlinks.json (só prod)
ENV_NAME=production              # production (default) | staging — gates comportamento per-environment
```

Sem `ANTHROPIC_API_KEY` o app cai pro fallback de seed embutido (12 auê Originals). Sem `APIFY_API_TOKEN` a pipeline Instagram silenciosamente vira no-op.

---

## Environments & Deploy

Dois services no Railway, mesmo código, configs diferentes:

| Env | Branch | URL | Volume / DB |
|---|---|---|---|
| Production | `main` | `reroot-production.up.railway.app` | volume separado |
| Staging | `dev` | (subdomínio gerado pelo Railway) | volume separado |

Sync automático: `.github/workflows/sync-staging.yml` faz `merge main → dev` em cada push pra `main` → Railway redeploya staging com a baseline de prod. Commits experimentais que ficam **só** em `dev` sobrevivem ao merge (até causarem conflito).

Comportamento per-environment via env var (`ENV_NAME`), nunca via branch divergente — padrão [12-factor app](https://12factor.net/config) — código unificado, promoção é só flipar a flag em prod.

---

## What's Next

**Supply side**:
- Submission self-service pra parceiros (`POST /events/submit` já existe; falta formulário público)
- Expandir lista de Instagram conforme novos venues aparecerem
- Pilot do selo "⭐ Parceiro auê" com 3–5 cafés locais

**Discovery side**:
- Buscador completo no catálogo
- Maps view ("eventos perto de mim")
- Mais chips de personalização (lugares já frequentados, bairros favoritos, comparação de preço com histórico)

**Distribução**:
- Closed beta TWA no Play Store Internal Testing (em andamento)
- TestFlight no iOS quando o app tiver tração e o Apple Dev account valer os $99/ano
- Primeira meetup auê real como fly-wheel de conteúdo + aquisição
