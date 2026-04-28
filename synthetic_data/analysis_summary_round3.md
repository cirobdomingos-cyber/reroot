# Synthetic Data Analysis Summary — Round 3

**Generated:** 2026-04-27
**Personas:** 12 | **Total feedbacks:** 48 | **Journey moments:** 144
**Round 1 reference:** `analysis_summary.md` (16 personas, NPS = 0)
**Round 2 reference:** `analysis_summary_round2.md` (12 personas, NPS = +8)

**Major context shift:** R3 is the first round AFTER the **Reroot → auê pivot**
(April/2026). R1 and R2 measured a wellness/social-re-entry product; R3
measures a Curitiba events catalog with festive voice. All R3 personas are
Curitiba locals (vs R1's global cities) — ages 19–58, 12 distinct neighborhoods,
mixed lifestyles (festeiro, cultural, atlético, criativo, parente, comunitário).

---

## NPS Round 3

| Score | Persona | Classification |
|---|---|---|
| 8.5 | P33 Camila (27, técnica de enfermagem, divorciada) | Passive |
| 8.0 | P29 Renata (34, designer, mãe solo) | Passive |
| 8.0 | P30 Dirceu (58, aposentado, viúvo) | Passive |
| 8.0 | P31 Isabela (23, arte/criativo) | Passive |
| 8.0 | P40 Fábio (44, divorciado co-parentalidade) | Passive |
| 7.8 | P34 Lorena (19, comunitário) | Passive |
| 7.8 | P35 Marcos (47, parente) | Passive |
| 7.8 | P36 Beatriz (31, expat cultural) | Passive |
| 7.8 | P37 Gustavo (22, atlético/repúblicas) | Passive |
| 7.8 | P38 Sônia (54, cultural / aposentada) | Passive |
| 7.8 | P39 Rodrigo (38, casado pragmático) | Passive |
| 7.0 | P32 Thiago (41, parente — 1 detractor message) | Passive |

**Per-persona NPS = 0 promoters, 0 detractors, 12 passives** — TODA a base 7.0–8.5.

**Per-message NPS = (7 promoters − 1 detractor) / 48 × 100 = +12.5**

### NPS Trend: R1 → R2 → R3

| Metric | R1 | R2 | R3 | Delta R2→R3 |
|---|---|---|---|---|
| NPS Score | 0 | +8 | +12 | **+4** |
| Promoters (per-msg) | 25.0% | 33.3% | **15%** | −18.3% |
| Passives (per-msg) | 50.0% | 41.7% | **83%** | +41.3% |
| Detractors (per-msg) | 25.0% | 25.0% | **2%** | −23.0% |

**Insight crítico:** O pivô **eliminou os detractors** (-23pp) — de 3 detractors em
R2 (privacy/family/accessibility) pra **1 detractor** em R3 (family filter, P32).
**MAS** os promoters caíram em paralelo (-18pp). A massa migrou pra passive.

**Tradução:** o auê é **"competente, não amado"**. Todo mundo aprova mas ninguém
defende. Esse é o modo "Sympla com cara melhor" — perigoso pra retenção viral
porque passive = não recomenda espontaneamente.

A boa notícia: os **7 promoter messages individuais** (Camila tem 3 sozinha)
são **emails longos e emocionais** — quando o app pega um caso real (mãe solo
sem rede, viúvo sem norte, divorciado nos fins de semana sem filho), vira
declaração de amor. O problema é frequência: o app pega forte em ~15% dos
moments e morno nos outros 85%.

---

## 1. Friction Map — onde a galera quebra

| Tema | Mentions | Severidade |
|---|---|---|
| **WhatsApp/in-app browser bloqueando install** | **36** | **🔴 CRITICAL** |
| **Catálogo gaps (descrição faltando)** | 44 | 🟡 High |
| iOS install / Safari friction | 31 | 🟡 High |
| Push notifications timing/clarity | 14 | 🟡 High |
| **Anti-game causa confusão** | 12 | 🟡 High |
| Companion chat (uso como filter workaround) | 11 | 🟡 High |
| Grupos / criação | 10 | 🟡 High |
| Filtro família/kids ausente | 7 | 🔴 Detractor |
| Privacidade / ocultação | 6 | 🟢 Medium |
| Login Google / Sign-In | 5 | 🟢 Medium |
| Recordes / motivação | 5 | 🟢 Medium |

---

## 2. Issues persistentes de R1/R2 que NÃO foram resolvidos

### 🔴 Family/kids filter (R1 → R2 → R3 = 3 rondas) — **DETRACTOR DETERMINÍSTICO**
- **R1**: P02 Maria (mãe solo) frustrada
- **R2**: P19 Beatriz (parent/heartbroken) = detractor explícito
- **R3**: P32 Thiago (parente, 41) = único detractor da rodada

`event.kidsWelcome` field existe no DB. **3 rounds, mesma reclamação, ZERO UI implementada.** Esse é um detractor estrutural agora.

> *"quando tentei achar coisa pra levar meu filho de 9 anos num fim de semana, não consegui"* — P32

### 🟡 Privacy panel — parcialmente resolvido
- R2 P27 (privacy) = detractor
- R3 P29 Renata fica procurando QR code, mas o painel de privacidade EXISTE agora ([Profile → 🔒 Privacy](src/screens/Profile.jsx)). O detractor sumiu. ✅
- Mas P30 Dirceu (58, viúvo) **não confia em Google Sign-In** — ele "usa Gmail mas nunca fez login social em nada". Issue diferente — confiança em SSO, não privacy panel.

### 🟡 Companion Chat = filter workaround (R2 → R3 = continua)
- 4/12 personas em R2 usaram chat pra contornar filtros faltando
- 4/12 em R3 também (P31, P33, P35, P36) — pra perguntar "tem evento de família?", "tem coisa gratuita?", "quem foi nesse evento?"
- O chat é band-aid, não fix. **Filtros estruturais ainda ausentes.**

### 🟢 WhatsApp migration (R2 issue) — **PARCIALMENTE resolvido com push**
- R2: 33% migravam pro WhatsApp pós-evento
- R3: redução notável — Renata, Camila, Beatriz **criam grupo dentro do auê** em vez de migrar (citam o grupo privado como motivo de promoção)
- MAS: **falta texto livre nos grupos** (P29 Renata: queria escrever "pessoal que tal esse?" ao adicionar evento). Migration ainda acontece pra galera mais social.

---

## 3. Pain points NOVOS identificados em R3

### 🔴 Critical — WhatsApp/Instagram in-app browser bloqueando install (36 menções)

**O #1 ponto de dor da rodada.** Quase TODA persona enfrentou:
- **P29 Renata (D1)**: quase desistiu — voltou pelo Safari só porque amiga insistiu
- **P30 Dirceu (D1)**: aviso `/install` apareceu mas ele ficou confuso e fechou
- **P33 Camila (D1)**: tela travou pelo WhatsApp, achou app quebrado
- **P34 Lorena (D1)**: in-app browser bloqueia Google Sign-In também
- **P39 Rodrigo (D1)**: levou DOIS dias pra instalar direito
- **P32 Thiago (D11)**: amigo Rodrigo criou grupo mas ele "não sabia que existia"

A `/install` page DETECTA in-app browser e mostra warning "abre no Safari". Mas o aviso não é **convincente o suficiente** — usuário fecha antes de copiar o link.

> *"Sorte que uma amiga insistiu"* — Camila P33
> *"Eu já ia fechar achando que era mais um app quebrado"* — Camila P33

**Custo real:** mesmo com onda 1 = 5 amigos íntimos, a mortalidade entre "recebeu o link no WhatsApp" → "instalou e usou" é provavelmente >30%.

### 🟡 High — Anti-game subtítulo causa confusão (12 menções)

A frase "Conquistas atualizam após o evento rolar" educa MAS o usuário espera o **Primeiro auê** (Bronze) **imediato** ao confirmar 1º evento. Não veio → confusão:

> *"Vê o subtítulo... e fica confuso — o evento foi ontem, ainda não rolou hoje?"* — P30 Dirceu, D10

**Insight:** anti-game é PRECISO mas **first_rsvp deveria ser exceção** (já é binário Bronze, sem dano). Eu já marquei isso na decisão original mas deixou de aplicar pra todas as ladder badges. Bom ponto pra revisar.

### 🟡 High — Grupos sem mensagem de texto livre (P29, P31)

> *"queria escrever uma mensagem junto ('pessoal que tal esse?') mas não tem campo de texto"* — Renata, ao adicionar evento ao grupo

**Renata e Isabela** ambas tentaram comunicar contexto ao adicionar evento → não têm onde digitar. **Padrão WhatsApp ressuscitado.**

### 🟡 High — Adicionar evento externo a um grupo (P37 Gustavo)

Gustavo (atlético, república) achou um pelada da turma da capoeira no Instagram, queria adicionar **ao grupo da república** — mas só dá pra adicionar eventos do catálogo:

> *"Só tô com raiva que não dá pra adicionar evento externo no grupo ainda, isso me quebra"*

**Casos d'uso descobertos**: pelada de bairro, churrasco de família, festa de aniversário, jogo amistoso. Eventos da galera, fora do catálogo.

### 🟡 High — Conjuge/parceiro não converte (P29 Renata)

Renata instalou. Marido recebeu o link, **abriu no Chrome Android, perguntou se tem no Google Play, recusou**. Mesma fricção pra outros 2 amigos casados de Renata.

> *"então não vou usar não — ele não confia em PWA"*

A galera mais conservadora exige App Store. Beta PWA-only **escolhe um corte demográfico** — não é neutro.

### 🟢 Medium — Conquistas vs Recordes confunde (P33 Camila)

Os dois nomes (substantivo plural feminino, similar significado) ficam adjacentes na Profile. Camila ficou ~30s perdida.

### 🟢 Medium — RSVP é individual, não grupal (P35 Marcos)

Pai de 2, queria confirmar "eu + 2 filhos" no mesmo evento. Não tem campo de quantidade. Vira RSVP só dele.

### 🟢 Medium — QR code parece "feature pra estranhos" (P30 Dirceu)

> *"Não vou a eventos grandes onde encontraria estranhos pra escanear. Parece feature de outro produto"*

QR é desenhado pra encontros presenciais com galera nova. Pra users da segunda metade da vida com círculos fechados, parece supérfluo.

---

## 4. Wins novos — o que CAPTURA

Quando o auê pega, pega forte. Padrões de promoter:

### Social proof = o gatilho de conversão
> *"Quando vi que a Júlia tava indo na feira zine eu fui sem nem pensar duas vezes"* — Isabela, P31
> *"Ver que meu amigo Rodrigo tinha confirmado antes — isso fez diferença"* — Fábio, P40

A feature **"X amigos vão"** é o que fecha a conversão. Mais forte que qualquer pitch ou recomendação.

### Carrossel de onboarding vende em 10s (P33 Camila)
> *"O que me segurou foi aquele carrossel de eventos no começo — show, sarau, festa, stand-up girando ali. Em 10 segundos eu já sabia que não era aquele catálogo genérico cheio de evento corporativo"*

Confirmação: o teaser animado funciona. Vale defender a feature.

### Voz auê (festiva, não babaca) ressoa (P36 Beatriz)
> *"A voz do app é leve sem ser idiota"*

Voz nova bem calibrada. R2 personas reclamavam de voz terapêutica/wellness; R3 personas elogiam a casual.

### Filtro Comunidade = descoberta de bairro (P34 Lorena)
> *"No auê eu achei um evento comunitário no meu bairro pelo filtro e isso pra mim já valeu o download"*

Curitiba-specific = vantagem real. Os filtros que conectam à vida local ganham fidelidade rápido.

### Grupos privados resolvem coordenação (P29 Renata)
> *"Finalmente não preciso mandar áudio perguntando 'alguém topa?' separadamente"*

Quando entendido, é o feature mais "sticky" pra galera 27–35 com círculos coordenadores.

### Resolve dor que nem sabia nomear (P40 Fábio, P30 Dirceu)
- Fábio: "não sabia o que fazer comigo nos fins de semana que meu filho fica com a mãe"
- Dirceu: "minha esposa sabia de tudo. Desde que ela morreu perdi o fio"

**Segmento mais quente:** **30–55 anos, com mudança recente de status civil ou familiar (divórcio, viuvez, ninho vazio).** Eles têm tempo, dinheiro, vontade de sair, e perderam a rede que organizava isso. **Mercado underserved gigante.**

---

## 5. Sentiment + Themes — Round 3

| Sentiment | Count | % | R2 |
|---|---|---|---|
| Positive | 35 | **73%** | 58.3% |
| Neutral | 13 | 27% | 29.2% |
| Negative | **0** | **0%** | 12.5% |

**Negative virou ZERO**. Detractors também caíram. O auê eliminou os "isso não é pra mim" estruturais do Reroot. Mas não criou polarização emocional positiva tampouco.

| Tema | Mentions | R2 rank → R3 rank |
|---|---|---|
| `eventos` | 40 | 1 → **1** |
| `amigos` | 18 | 5 → **2** |
| `conexoes` | 17 | 5 → **3** |
| `grupos` | 13 | — → **4** |
| `ui_ux` | 13 | 2 → 5 |
| `voz_marca` | 10 | — → **6** (NOVO) |
| `badges` | 7 | — → 7 (NOVO) |
| `install` | 5 | — → 8 (NOVO) |
| `anti_game` | 4 | — → 9 (NOVO) |
| `push` | 4 | — → 10 |

**Mudanças notáveis vs R2:**
- `amigos` + `conexoes` SUBIRAM de rank 5 pra 2 e 3 — a camada social virou the show
- `filtros` saiu do top 4 — drop sutil mas suspeito (galera tá usando Companion como workaround)
- `voz_marca` é tema NOVO no top 6 — o pivô voice é notado e elogiado
- `install` é tema NOVO no top 8 — fricção real do PWA

---

## 6. Recomendações Priorizadas

### P0 — Bloqueia onda 2 (>5 amigos)

#### P0-A: Banner forte no `/install` quando in-app browser
**Problema:** 36 menções de WhatsApp bloqueando install. Maior single ponto de fricção da rodada.

**Hoje:** `/install` detecta in-app, mostra aviso amarelo + botão "Copiar link".

**Fix:**
1. Banner FULL-SCREEN modal (não inline) quando in-app browser detectado, vermelho/laranja, com:
   - "⚠️ Esta página está aberta no WhatsApp/Instagram"
   - "Aqui o app NÃO INSTALA. Toca no botão pra copiar e abrir no Safari/Chrome"
   - Botão GIGANTE "📋 Copiar link e abrir Safari" — single action, no decision
2. **Fallback para Android**: `intent://...#Intent;scheme=https;package=com.android.chrome;end` — abre direto no Chrome via deep link
3. Mensagem-template do compartilhar (Profile → "📲 Compartilhar") inclui linha **"⚠️ Não abre pelo WhatsApp — toca aqui pra abrir direto no Chrome/Safari"**

**Estimativa de impacto:** reduz mortalidade do flow WhatsApp → install em ~50%. Crítico pra onda 2.

#### P0-B: Filtro Família/Kids — 3 rondas pendente
**Problema:** P02 (R1) → P19 (R2 detractor) → P32 (R3 detractor). 3 rounds, mesma issue. Estrutural.

**Fix em ~10 linhas:** chip 👨‍👩‍👧 Família no Events.jsx → filtra `event.kidsWelcome === true`. Field já existe no DB.

**Já estava como P1-A na R2.** Não foi feito. **Promove de P1 → P0.**

### P1 — Dirige NPS pra +20 (este sprint)

#### P1-A: First_rsvp = unlock IMEDIATO
**Problema:** 12 menções de "Conquistas atualizam após evento rolar" causando confusão. Bronze do Primeiro auê deveria ser excepção do anti-game (já documentado na decisão original mas reverteu).

**Fix:** verificar se o evaluate() do badges.py honra o "instant for first_rsvp" (e first_group). Atualmente está aplicando mature filter pra TODOS — deveria pular first_rsvp/first_group como bonus de boas-vindas. **Bug de implementação, não design.**

**Impacto:** primeiro RSVP recompensa imediato → reforço positivo no momento crítico de aderência.

#### P1-B: Texto livre ao adicionar evento ao grupo (P29, P31)
**Problema:** Galera quer escrever "que tal esse pessoal?" junto. Não tem.

**Fix:** Campo opcional `note` em `POST /groups/{group_id}/events`. Mostra como caption no card do evento dentro do grupo. ~30 linhas backend + UI.

#### P1-C: Adicionar evento "livre" (não-catálogo) ao grupo (P37)
**Problema:** Pelada da turma, churrasco da família, jogo da Federação amistoso — eventos do dia-a-dia da galera, fora do catálogo Sympla/MON/etc. Gustavo "não consegue".

**Fix:** Modal "Adicionar evento ao grupo" com 2 modos:
1. **"Do catálogo auê"** (atual)
2. **"Evento da galera"** — campos livres: nome, venue (texto), data, observação

Backend: `group_events` table já existe e suporta isso. **Frontend só precisa expor.**

#### P1-D: Renomear "Recordes" → "Estatísticas" (P33)
**Problema:** Conquistas + Recordes confundem. Plurais femininos com sentidos próximos.

**Fix:** "Recordes" → "Estatísticas" ou "Resumo da semana". Ou mover pra outra tela (Home?) pra separar fisicamente. ~3 linhas.

### P2 — Próximo trimestre

#### P2-A: Multi-RSVP / "Trazendo +X" (P35)
Field `bringing_count` no RSVP — pai de família registra "eu + 2", venue/group sees "Marcos vai com mais 2". Padrão Eventbrite.

#### P2-B: Onboarding pós-install que pergunta "qual o seu auê?"
**Problema:** P38 Sônia (54, cultural) "pulei a parte de Grupos, não entendi". O catálogo entrega a vibe geral mas não personaliza por persona.

**Fix:** Após primeiro RSVP, modal que pergunta:
- "Você quer descobrir o que rola?" (catálogo passivo)
- "Você quer organizar saídas com a galera?" (Grupos primário)
- "As duas coisas"

Mostra section relevante no Home. Reduz "Grupos não é pra mim" silencioso de boomers.

#### P2-C: Native app (Capacitor + TestFlight)
**Quando**: ~50 ativos confirmados. Resolve P29 (marido recusou PWA), P39 (instalação difícil). Custo: $99/ano + Mac (cloud build).

#### P2-D: Privacy default = "amigos" (não "todos")
P30 Dirceu (58) desconfia de Google Sign-In. Settings já existem mas **default em "todos visíveis"** — agressivo demais pra demografia 50+.

### P3 — Estratégico

- **Companion Chat ainda é band-aid pra filtros faltando** — ou implementa filtros (preço, família, dia-da-semana) e diminui dependência do chat, ou abraça e melhora chat (resposta < 2s, não 4s+).
- **EN content** — não testado em R3 (todas personas pt-BR).
- **Curitiba-specific deepening**: filtro por bairro real, não só inferido. P34 Lorena ama o filtro Comunidade — escala isso.

---

## 7. Compound NPS Projection

| Persona | Hoje | Se P0+P1 shipados |
|---|---|---|
| P29 Renata | 8.0 | **9-10** (resolve marido + texto-livre + Bronze imediato) |
| P32 Thiago | 7.0 | **9** (filtro família resolve 100%) |
| P33 Camila | 8.5 | **10** (Estatísticas vs Conquistas claro + chat <2s) |
| P37 Gustavo | 7.8 | **9** (evento externo no grupo) |
| P40 Fábio | 8.0 | **9** (Bronze imediato faz primeira semana shine) |

**Projeção:** R4 NPS pós-P0+P1 = **+25 a +35**.

A questão não é "tem feature errada". É **"várias features 80% ali, faltam os 20% que viram conversor de promoter"**.

---

## 8. Key Insights

### O auê é "competente mas não amado" hoje
Eliminou detractors estruturais (R2: 25% → R3: 2%) MAS não criou evangelistas (R2: 33% → R3: 15%). Todo mundo aprova, ninguém defende. Esse é o modo "Sympla com cara melhor" — risco de retenção viral baixa.

### A camada social VENDE
`amigos` + `conexoes` subiram de rank 5 pra 2-3. **O pitch "ver quem da sua galera vai" é o gatilho de conversão.** Reforça o argumento de continuar investindo na social layer (push amigo confirmou, friend graph, grupos).

### Demografia underserved descoberta
**30-55 anos com mudança recente de status civil/familiar** (divórcio, viuvez, ninho vazio) = segmento mais quente. Têm tempo + dinheiro + vontade + perderam a rede que organizava isso. P29, P30, P40, P36 todos cabem. **3 dos 7 promoter messages são desse perfil.**

### A fricção #1 é distribuição, não produto
WhatsApp/Instagram in-app browsers = 36 menções. **A galera está chegando no app pelo canal certo (boca-a-boca via WhatsApp) e travando antes de instalar.** O fix é P0-A — single biggest unlock pra onda 2 e 3.

### Anti-game funcionou tecnicamente, falhou em UX
Mature filter elimina farm de spike+cancel ✅. Mas o subtítulo "Conquistas atualizam após o evento rolar" cria confusão pro **first_rsvp** que deveria unlockar imediato. Bug de implementação — não bug de design.

---

> **Bottom line:** R3 mostra um produto **maduro tecnicamente, ainda passive emocionalmente**. As 4 mudanças P0+P1 (banner WhatsApp, filtro família, Bronze imediato, texto livre nos grupos) provavelmente movem 3-4 personas de Passive pra Promoter. **Não estamos longe de NPS +25.**
