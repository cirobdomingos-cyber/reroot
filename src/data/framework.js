// ── Multi-week framework library ───────────────────────────
// Each week has: title, subtitle, methodology, prompts, reframes, actions, note
// Journey.jsx uses getFramework(currentWeek) to render the right one.

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

// Returns the framework for the given week, falling back to week 3 if not yet written
export function getFramework(week) {
  return FRAMEWORKS[week] ?? FRAMEWORKS[3]
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
