// ── Multi-week framework library ───────────────────────────
// Each week has: title, subtitle, methodology, prompts, reframes, actions, note
// Journey.jsx uses getFramework(currentWeek, profile) to render the right one.
//
// How personalization works:
//   1. FRAMEWORKS[week] holds the base content (shared scaffold — title, reframes,
//      methodology note).
//   2. PROFILE_OVERRIDES[profile][week] holds the *tailored* parts — subtitle,
//      the first prompt, the first action, and the closing note. Those are the
//      pieces users notice first and that most shape how the week "feels."
//   3. getFramework(week, profile) merges the two. Missing overrides fall back
//      to the base, so it's always safe to add profiles incrementally.

export const FRAMEWORKS = {
  1: {
    title: 'O Chão Sob Seus Pés',
    subtitle: 'Antes de aparecer para os outros, você precisa saber onde está pisando. Esta semana é sobre orientação — não performance.',
    methodology: 'Gerado por IA com metodologia revisada por terapeutas · Não substitui terapia',
    prompts: [
      {
        num: '01',
        question: 'Como seria sua vida social ideal em 12 semanas — não perfeita, apenas melhor do que agora?',
        hint: 'Seja específico. Uma pessoa, um lugar, um sentimento.',
      },
      {
        num: '02',
        question: 'Quando foi a última vez que você se sentiu genuinamente confortável perto de outras pessoas? O que tornou isso possível?',
        hint: 'As condições importam mais do que o evento.',
      },
      {
        num: '03',
        question: 'Qual é a situação social que você vem evitando há mais tempo?',
        hint: 'Dê um nome. Você não precisa enfrentá-la esta semana — só nomear.',
      },
    ],
    reframes: [
      {
        label: 'Reframe 01 — A Linha de Partida',
        from: '"Estou tão atrás. Todo mundo já tem isso resolvido."',
        to: '"Todo mundo começa em algum lugar. O meu é aqui, esta semana."',
      },
      {
        label: 'Reframe 02 — A Armadilha da Pressão',
        from: '"Preciso ser social o tempo todo pra melhorar."',
        to: '"Uma pequena interação por semana já faz diferença. Isso basta."',
      },
    ],
    actions: [
      { step: 1, text: '**Leia a apresentação do seu cohort** e note uma pessoa cuja situação parece familiar.' },
      { step: 2, text: '**Vá a um evento** da sua lista — mesmo que saia mais cedo. Chegar já conta.' },
      { step: 3, text: '**Escreva três frases** sobre como se sentiu antes, durante e depois.' },
    ],
    note: 'A Semana 1 não é sobre resultados — é sobre **mostrar ao seu sistema nervoso que nada catastrófico acontece** quando você aparece. Repetição constrói segurança. Segurança constrói conexão.',
  },

  2: {
    title: 'O Primeiro Sim',
    subtitle: 'Dizer sim é mais difícil do que parece. Esta semana é sobre o espaço entre "eu deveria ir" e "eu vou."',
    methodology: 'Gerado por IA com metodologia revisada por terapeutas · Não substitui terapia',
    prompts: [
      {
        num: '01',
        question: 'O que aconteceu no seu corpo da última vez que você disse sim para algo social e deu certo?',
        hint: 'Perceba a memória física — ombros, peito, respiração.',
      },
      {
        num: '02',
        question: 'Qual é a sua estratégia de saída mais comum, e do que ela te protege?',
        hint: 'Sem julgamento aqui. Estratégias de saída existem por uma razão.',
      },
      {
        num: '03',
        question: 'Se um amigo próximo descrevesse seu melhor lado social, o que diria?',
        hint: 'Essa versão de você ainda existe. Estamos apenas reconstruindo o acesso.',
      },
    ],
    reframes: [
      {
        label: 'Reframe 01 — A Janela de Decisão',
        from: '"Vou decidir se estou a fim no dia."',
        to: '"Eu decido agora. Sentimentos são consultados, não estão no comando."',
      },
      {
        label: 'Reframe 02 — O Suficientemente Bom',
        from: '"Se não for um evento incrível, não valeu a pena ir."',
        to: '"Neutro já é uma vitória. Levemente desconfortável significa crescimento."',
      },
    ],
    actions: [
      { step: 1, text: '**Confirme presença em um evento** antes de sexta — se comprometer antecipadamente muda o jogo.' },
      { step: 2, text: '**Defina um mínimo**: você só precisa ficar 20 minutos. Deixe-se ultrapassar esse limite.' },
      { step: 3, text: '**Mande uma mensagem** para alguém do cohort após o evento. Uma frase basta.' },
    ],
    note: 'A pesquisa sobre ansiedade social mostra consistentemente que **a evitação mantém o medo**. Você não espera se sentir corajoso — você age, e a coragem vem depois. O único trabalho desta semana: um sim.',
  },

  3: {
    title: 'O Ritual de Reentrada',
    subtitle: 'Um guia estruturado para aparecer socialmente após uma longa pausa — sem pressão, performance ou fingimento.',
    methodology: 'Gerado por IA com metodologia revisada por terapeutas · Não substitui terapia',
    prompts: [
      {
        num: '01',
        question: 'O que "aparecer" significa pra você agora — e como isso é diferente do que significava dois anos atrás?',
        hint: 'Reserve 5 minutos. Escreva livremente. Não edite.',
      },
      {
        num: '02',
        question: 'Cite um pequeno momento desta semana em que você se sentiu genuinamente você — mesmo que brevemente.',
        hint: 'Não precisa ser social. Uma caminhada conta.',
      },
      {
        num: '03',
        question: 'Qual é a história que você conta para si mesmo antes de recusar um convite?',
        hint: 'Dar nome à história é o primeiro passo para mudá-la.',
      },
    ],
    reframes: [
      {
        label: 'Reframe 01 — A Armadilha da Expectativa',
        from: '"Preciso ser interessante / engraçado / estar \'ligado\' quando saio."',
        to: '"Meu único trabalho é aparecer. O resto é opcional."',
      },
      {
        label: 'Reframe 02 — O Mito da Energia',
        from: '"Vou quando me sentir pronto / tiver mais energia."',
        to: '"Energia vem depois da ação, não antes. Pequenos passos primeiro."',
      },
    ],
    actions: [
      { step: 1, text: 'Vá a **um evento** da sua prescrição. Não dois. Um.' },
      { step: 2, text: '**Diga seu nome primeiro** para alguém que você não conhece. Esse é o objetivo inteiro.' },
      { step: 3, text: '**Escreva por 5 minutos** após o evento. Não o que aconteceu — como você se sentiu ao entrar.' },
    ],
    note: 'Pesquisas sobre reentrada social mostram consistentemente que o momento decisivo é **atravessar a porta** — não como o evento vai. Seu sistema nervoso precisa de repetição, não perfeição.',
  },
}

// ── Profile-specific overrides ─────────────────────────────
// For each profile × week, we tweak the pieces users feel most:
//   - subtitle: sets the emotional register for the week
//   - firstPrompt: a reflection question matched to the profile's worldview
//   - firstAction: a concrete step calibrated to the profile's intensity
//   - note: the closing reframe that seals the week
// Missing fields fall back to the base framework.
export const PROFILE_OVERRIDES = {
  gentle: {
    1: {
      subtitle: 'Você não está atrasado. Esta semana é só um convite para olhar em volta com gentileza — sem nenhuma meta.',
      firstPrompt: {
        num: '01',
        question: 'Qual é o menor passo social que você conseguiria dar esta semana sem sentir que está se forçando?',
        hint: 'Pequeno de verdade. Um café sozinho num lugar com gente conta.',
      },
      firstAction: { step: 1, text: '**Escolha um único lugar calmo** (café, praça, livraria) e passe 20 minutos lá. Não precisa falar com ninguém.' },
      note: 'Pra você, a Semana 1 é sobre **presença, não participação**. Estar perto de pessoas já move o sistema nervoso. Você não precisa de mais nada ainda.',
    },
    2: {
      subtitle: 'O sim desta semana é com você mesmo — um compromisso leve, não uma prova de coragem.',
      firstAction: { step: 1, text: '**Reserve um evento pequeno** (até 10 pessoas) e permita-se desmarcar se precisar. O compromisso não é ir — é marcar.' },
      note: 'A versão gentil do primeiro sim é **deixar a porta aberta**, não atravessá-la à força. Marcar já conta como ter dito sim.',
    },
    3: {
      subtitle: 'Reentrada não é espetáculo. Esta semana é sobre aparecer do seu jeito, no seu ritmo — mesmo que ninguém note.',
      firstAction: { step: 1, text: '**Vá a um evento e se dê permissão de só observar** por 15 minutos antes de decidir se quer interagir.' },
      note: 'Observar é participar. Seu sistema nervoso está fazendo o trabalho mesmo quando você está quieto no canto da sala.',
    },
  },

  explorer: {
    1: {
      subtitle: 'Você gosta de variedade — esta semana é sobre mapear o terreno antes de escolher onde plantar.',
      firstPrompt: {
        num: '01',
        question: 'Se você pudesse experimentar três cenas sociais diferentes esta semana, quais seriam?',
        hint: 'Não precisa ir em todas. Listar já é útil.',
      },
      firstAction: { step: 1, text: '**Explore a aba Eventos** e salve três eventos de *categorias diferentes* — nenhum precisa ser o "certo".' },
      note: 'Exploradores aprendem fazendo, não planejando. Sua tarefa é **gerar dados sobre si mesmo** — o que te energiza, o que te drena. Três experimentos, nada mais.',
    },
    2: {
      subtitle: 'O primeiro sim explorador é escolher o evento mais *diferente* — não o mais confortável.',
      firstAction: { step: 1, text: '**Escolha o evento que mais te deu curiosidade** (não o mais fácil) e confirme presença antes de racionalizar.' },
      note: 'Sua melhor bússola é curiosidade, não medo. Quando um evento te intriga e te assusta ao mesmo tempo, esse é o bom.',
    },
    3: {
      subtitle: 'Reentrada pra você é sobre redescobrir — que cenas ainda te acendem, quais ficaram pra trás.',
      firstAction: { step: 1, text: '**Vá a um evento e pergunte a alguém** "o que te trouxe aqui?" Use a curiosidade como escudo.' },
      note: 'Exploradores se conectam melhor quando estão **em modo pesquisador**. Perguntar tira o foco de você e cria conexão como efeito colateral.',
    },
  },

  builder: {
    1: {
      subtitle: 'Você não quer rede — quer algumas pessoas de verdade. Esta semana é sobre identificar por onde começar.',
      firstPrompt: {
        num: '01',
        question: 'Das pessoas que você já conhece (mesmo de longe), quem você gostaria de conhecer melhor se tivesse uma desculpa?',
        hint: 'Pense em 2-3 nomes. A desculpa a gente inventa na semana 2.',
      },
      firstAction: { step: 1, text: '**Liste 3 pessoas** que você gostaria de ver mais e mande uma mensagem curta pra uma delas ainda hoje.' },
      note: 'Builders constroem **amizades reais, não redes**. Uma mensagem pra alguém certo vale mais que dez eventos. Sua semana 1 é identificar o "quem".',
    },
    2: {
      subtitle: 'O primeiro sim pra você é propor — não esperar ser convidado. Um café vale mais que um evento grande.',
      firstAction: { step: 1, text: '**Convide uma pessoa** (do cohort ou não) para um café específico. Dia, hora, lugar. Sem "a gente marca".' },
      note: 'A fricção que mata amizade adulta é **o "a gente marca" vago**. Builders vencem sendo a pessoa que manda o convite concreto.',
    },
    3: {
      subtitle: 'Reentrada pra você não é sobre quantidade — é sobre abrir espaço pra conversa de verdade.',
      firstAction: { step: 1, text: '**Vá a um evento e foque em uma conversa só** — mesmo que longa. Uma boa é melhor que cinco superficiais.' },
      note: 'Sua força é profundidade. Quando você achar uma pessoa interessante, fique. Não precisa "circular" por ninguém.',
    },
  },

  rebounder: {
    1: {
      subtitle: 'Algo mudou na sua vida e você quer recalibrar rápido. Esta semana é sobre marcar o reset — não sobre cautela.',
      firstPrompt: {
        num: '01',
        question: 'Se você tivesse que descrever a "versão antes" e a "versão agora" de você em uma frase cada, como seriam?',
        hint: 'Não precisa ser bonito. Seja honesto.',
      },
      firstAction: { step: 1, text: '**Escolha um evento esta semana** — o primeiro que couber na sua agenda. Vá. Não procrastine escolhendo.' },
      note: 'Rebounders precisam de **velocidade, não planejamento**. Seu sistema nervoso quer evidência de que a vida nova funciona. Entregue essa evidência rápido.',
    },
    2: {
      subtitle: 'O primeiro sim é simultâneo: você diz sim pra duas coisas esta semana, não uma.',
      firstAction: { step: 1, text: '**Confirme presença em dois eventos** esta semana — um confortável, um desafiador. Ambos.' },
      note: 'Pra você, consistência importa mais que intensidade. Dois pequenos sins criam momentum que um grande não cria.',
    },
    3: {
      subtitle: 'Reentrada pra você é sobre **reivindicar espaços novos** — não recuperar os antigos.',
      firstAction: { step: 1, text: '**Vá a um lugar onde você nunca foi antes** — mesmo que sozinho. A novidade é o remédio.' },
      note: 'Espaços antigos carregam a versão antiga de você. Pra se reinventar, seu sistema precisa de **contextos que ainda não têm história**.',
    },
  },

  depth: {
    1: {
      subtitle: 'Você não quer pequenas conversas — quer sentido. Esta semana é sobre reconhecer que isso é uma força, não um problema.',
      firstPrompt: {
        num: '01',
        question: 'Que tipo de conversa te faz esquecer das horas — e onde você costumava encontrar essas conversas?',
        hint: 'A pergunta é sobre contexto, não sobre pessoa específica.',
      },
      firstAction: { step: 1, text: '**Identifique um evento** que favoreça conversa (book club, clube de escrita, café filosófico) e marque presença.' },
      note: 'Pra você, **o formato importa mais que a frequência**. Um evento bem escolhido por mês vale mais que quatro happy hours. Filtre sem culpa.',
    },
    2: {
      subtitle: 'O primeiro sim é pra um formato que *permite profundidade* — não pra qualquer evento social.',
      firstAction: { step: 1, text: '**Escolha o evento mais pequeno e específico** da sua lista. Menos pessoas = mais chance de conversa real.' },
      note: 'Depth profiles perdem energia em ambientes grandes e barulhentos. Escolher o formato certo **não é timidez, é estratégia**.',
    },
    3: {
      subtitle: 'Reentrada pra você é sobre encontrar um lugar de conversa — não um lugar qualquer.',
      firstAction: { step: 1, text: '**Vá a um evento e faça uma pergunta real** a alguém. "Como vai?" não conta. "O que te trouxe pra isso?" conta.' },
      note: 'Sua entrada no mundo social é por **conversa, não por presença**. Uma boa pergunta abre mais porta que uma hora de small talk.',
    },
  },

  steady: {
    1: {
      subtitle: 'Você prospera com rotina. Esta semana é sobre escolher um hábito social repetível — não um evento isolado.',
      firstPrompt: {
        num: '01',
        question: 'Qual é o dia e horário da semana em que você tem mais energia social? Quando é que sair é mais fácil?',
        hint: 'Rotinas sociais são construídas em volta do seu ritmo natural, não contra ele.',
      },
      firstAction: { step: 1, text: '**Escolha um horário fixo** na semana (ex: terça 19h) e reserve mentalmente pra um encontro social recorrente.' },
      note: 'Steady profiles ganham pela **consistência, não pela variedade**. Mesmo evento, mesmo dia, toda semana. Três repetições viram sua nova vida.',
    },
    2: {
      subtitle: 'O primeiro sim é pro *mesmo* evento — duas semanas seguidas. Repetir é o plano.',
      firstAction: { step: 1, text: '**Confirme presença num evento que acontece toda semana**. O segundo comparecimento é mais importante que o primeiro.' },
      note: 'Ir uma vez é coincidência. Ir duas vezes é o início de uma rotina — e é aí que as pessoas começam a te reconhecer.',
    },
    3: {
      subtitle: 'Reentrada pra você é **tornar-se um regular** em algum lugar — não circular por muitos.',
      firstAction: { step: 1, text: '**Volte ao mesmo lugar da semana passada**. A familiaridade é o truque — e funciona nos dois lados.' },
      note: 'Ser reconhecido no balcão é o primeiro degrau de pertencimento. Seu plano não é conhecer todo mundo — é **ser conhecido em um lugar**.',
    },
  },

  curious: {
    1: {
      subtitle: 'Você é movido por interesse genuíno. Esta semana é sobre escolher o que quer entender melhor — sobre si mesmo ou sobre o mundo.',
      firstPrompt: {
        num: '01',
        question: 'Qual é uma pergunta que você está carregando sobre vida social que nunca verbalizou?',
        hint: 'Escreva a pergunta inteira, mesmo que pareça boba. Nomeá-la já é meio caminho.',
      },
      firstAction: { step: 1, text: '**Escolha um evento** que responde (ou desafia) uma dessas perguntas. Vá pra aprender, não pra performar.' },
      note: 'Curiosos reentram melhor **como aprendizes, não como participantes**. Se você for pra observar e entender, a pressão de "ser social" evapora.',
    },
    2: {
      subtitle: 'O primeiro sim é pra uma cena social que você sempre teve curiosidade — mas nunca entrou.',
      firstAction: { step: 1, text: '**Escolha uma cena nova** (gênero musical, tipo de esporte, hobby) e vá a um evento dela como iniciante declarado.' },
      note: 'Declarar-se iniciante **remove a pressão de parecer que pertence**. Ninguém espera que você saiba — e isso é liberdade.',
    },
    3: {
      subtitle: 'Reentrada pra você é sobre aprender a ler pessoas de novo — como quando você era criança.',
      firstAction: { step: 1, text: '**Vá a um evento e escolha uma pessoa pra observar** sem julgar por 10 minutos. Depois tente conversar com ela.' },
      note: 'Observação antes de interação **devolve sua confiança social**. Você lembra como ler o ambiente. Só precisa dar permissão pra si mesmo.',
    },
  },
}

// Returns the framework for the given week merged with profile-specific overrides.
// Falls back gracefully: unknown week → week 3; unknown/missing profile → base content.
export function getFramework(week, profile = null) {
  const base = FRAMEWORKS[week] ?? FRAMEWORKS[3]
  const override = profile ? PROFILE_OVERRIDES[profile]?.[week] : null
  if (!override) return base

  // Merge: prompts[0] and actions[0] are replaced when the override provides them;
  // everything else falls back to base content.
  const prompts = override.firstPrompt
    ? [override.firstPrompt, ...base.prompts.slice(1)]
    : base.prompts
  const actions = override.firstAction
    ? [override.firstAction, ...base.actions.slice(1)]
    : base.actions

  return {
    ...base,
    subtitle: override.subtitle ?? base.subtitle,
    prompts,
    actions,
    note: override.note ?? base.note,
  }
}

// ── Journey timeline ───────────────────────────────────────
// States are computed dynamically in Profile.jsx based on currentWeek
export const TIMELINE = [
  { week: 1,  label: 'Semana 1',              event: 'Orientação & Primeiro Framework',  note: 'Framework: O Chão Sob Seus Pés' },
  { week: 2,  label: 'Semana 2',              event: 'Primeiro Evento',                  note: 'Framework: O Primeiro Sim' },
  { week: 3,  label: 'Semana 3',              event: 'O Ritual de Reentrada',            note: 'Framework: O Ritual de Reentrada' },
  { week: 6,  label: 'Semana 6 · Marco',      event: 'Encontro do Cohort',               note: 'Encontro presencial de todo o cohort' },
  { week: 12, label: 'Semana 12 · Final',     event: 'Raízes Estabelecidas 🌱',          note: 'Complete seu arco de 12 semanas' },
]
