// ── Reroot i18n — PT (default) / EN ───────────────────────
// Usage: const t = useT()  →  t.nav_home, t.events_title, etc.
// Add new keys to BOTH locales or the app will fall back to the key name.

export const T = {
  pt: {
    // ── Nav ──────────────────────────────────────────────
    nav_home:    'Início',
    nav_events:  'Eventos',
    nav_journey: 'Jornada',
    nav_profile: 'Perfil',

    // ── Onboarding ────────────────────────────────────────
    onboarding_tagline:               'Sua jornada de reconexão',
    onboarding_cohort_badge:          'Cohort Primavera 2026 — Ao vivo',
    onboarding_headline:              'Você está entrando no',
    onboarding_cohort_name:           'Cohort Primavera Curitiba',
    onboarding_subtitle:              'Um grupo pequeno e cuidadoso de pessoas na mesma fase da vida — não milhares de estranhos.',
    onboarding_members:               '24 membros no seu cohort',
    onboarding_closes:                'Mesma fase de vida · Cohort fecha em 3 dias',
    onboarding_name_label:            'Seu primeiro nome',
    onboarding_name_placeholder:      'ex: Carlos, Mariana...',
    onboarding_neighborhood_label:    'Seu bairro',
    onboarding_neighborhood_placeholder: 'ex: Batel, Centro, Água Verde',
    onboarding_interests_label:       'Escolha seus interesses',
    onboarding_join_btn:              'Entrar no Cohort Primavera →',
    onboarding_or:                    'ou continue manualmente',
    onboarding_privacy:               '🔒 Só primeiro nome · Sem redes sociais · Não é app de namoro',

    // ── Home ─────────────────────────────────────────────
    home_default_name:      'você',
    greeting_morning:       'Bom dia',
    greeting_afternoon:     'Boa tarde',
    greeting_evening:       'Boa noite',
    home_journey_label:     'Sua Jornada',
    home_week:              'Semana',
    home_of:                'de',
    home_stat_rsvpd:        'Confirmados',
    home_stat_frameworks:   'Frameworks lidos',
    home_stat_attended:     'Eventos frequentados',
    home_prescription_label: 'Sua prescrição desta semana',
    home_prescription_protocol: 'eventos · Protocolo Semana',
    home_prescription_sub:  'Curado para seu estágio de reconexão',
    home_cohort_label:      'Atividade do cohort',
    home_cohort_going:      'membros do cohort vão para',
    home_framework_label:   'Framework desta semana',
    home_framework_badge:   'Framework IA · Semana',
    home_framework_desc:    'Reflexão estruturada + exercícios de reframe para aparecer socialmente após uma longa pausa.',
    home_framework_verified:'🛡️ Gerado com metodologia revisada por terapeutas',
    home_rsvp:              'Confirmar',
    home_going:             'Confirmado ✓',
    home_be_first:          'Seja o primeiro',
    home_cohort_completed:  'acabou de completar o framework da Semana 3',

    // ── Filter: price & family ────────────────────────────
    filter_all_prices:      'Todos',
    filter_free:            'Grátis',
    filter_paid:            'Pago',
    filter_kids_welcome:    'Kids Welcome',
    filter_hide_curated:    'Só reais',
    filter_hide_curated_on: 'Sem sugestões AI',
    tag_free:               'Grátis',
    tag_kids:               '👶 Kids Welcome',
    tag_curated:            'Sugestão AI',
    tag_curated_long:       'Sugestão curada por AI — não é evento real',
    tag_private:            'Meu evento',
    tag_private_long:       'Evento privado criado por você',

    // ── Events ───────────────────────────────────────────
    events_title:           'Eventos',
    events_sub:             'Curitiba · Cohort Primavera · 24 membros',
    events_live:            '🟢 Ao vivo',
    events_static:          '🌿 Curitiba',
    events_search:          'Buscar eventos, locais...',
    events_empty_search:    'Nenhum evento encontrado para',
    events_empty_cat:       'Nenhum evento encontrado nessa categoria.',
    events_be_first:        'Seja o primeiro do cohort',
    events_going:           'confirmados',
    events_small:           'GRUPO PEQUENO',
    events_medium:          'GRUPO MÉDIO',
    events_large:           'EVENTO GRANDE',
    events_rsvp:            'Confirmar',
    events_rsvped:          'Confirmado ✓',
    events_loading:         'Carregando...',
    events_low_pressure:    'Baixa pressão',
    events_why_good:        'Por que é bom pra você agora',
    events_first_cohort:    'Seja o primeiro do seu cohort',
    events_no_members:      'Nenhum membro do cohort ainda. Seja o primeiro a confirmar.',
    events_cancel_rsvp:     'Cancelar confirmação',
    events_rsvp_btn:        'Confirmar presença',
    events_attended_btn:    'Marcar como comparecido ✓',
    events_view_original:   'Ver evento original →',
    events_has_food:        'tem comida',
    events_food_drink:      '🍽️ Tem comida/bebida',
    events_week:            'Semana',
    events_save:            'Salvar',
    events_venue_open:      'Sempre aberto · Venha quando quiser',
    events_venue_hours:     'Horário',
    events_venue_frequent:  'membros do cohort frequentam',
    events_venue_no_members:'Nenhum membro do cohort ainda',
    events_venue_save_first:'Seja o primeiro do cohort a salvar este local.',
    events_venue_save:      'Salvar este local',
    events_venue_remove:    'Remover dos salvos',
    events_you:             'Você',
    events_saved_check:     'Salvo ✓',
    events_going_check:     'Confirmado ✓',

    // ── Journey ──────────────────────────────────────────
    journey_title:          'Framework Semanal',
    journey_sub:            '· Atualizado toda segunda',
    journey_framework_badge:'Framework Semana',
    journey_of:             'de',
    journey_companion_label:'Sua Companheira',
    journey_prompts_label:  'Perguntas de reflexão',
    journey_prompt_prefix:  'Pergunta',
    journey_reframes_label: 'Exercícios de reframe',
    journey_actions_label:  'Ações desta semana',
    journey_note_label:     'Uma nota da metodologia',
    journey_complete_btn:   'Marcar framework como completo',
    journey_completed_msg:  '📖 Framework completo — Badge conquistado!',

    // ── Profile ───────────────────────────────────────────
    profile_cohort:         'Cohort Primavera Curitiba · 24 membros',
    profile_member_badge:   '🌿 Membro Reroot · R$99/mês',
    profile_timeline_label: 'Linha do tempo',
    profile_badges_label:   'Badges conquistados',
    profile_membership_label:'Assinatura',
    profile_membership_title:'Membro Reroot',
    profile_membership_sub: 'Acesso completo · Cobrado mensalmente',
    profile_feature_1:      '✓ Frameworks semanais de IA (revisados por terapeutas)',
    profile_feature_2:      '✓ Eventos curados do cohort · Curitiba',
    profile_feature_3:      '✓ Cohort de 24 membros · Primavera 2026',
    profile_feature_4:      '✓ Rastreamento de jornada e badges de marcos',
    profile_referral_label: 'Indicado pelo seu terapeuta?',
    profile_referral_sub:   'Muitos terapeutas recomendam o Reroot como estrutura entre sessões. Insira o código deles para ter o primeiro mês grátis.',
    profile_referral_placeholder: 'ex: TERAPIA2026',
    profile_referral_btn:   'Aplicar',
    profile_referral_applied:'🎉 Primeiro mês grátis aplicado!',
    profile_reset:          '↺ Resetar demo',
    profile_language_label: 'Idioma · Language',

    // ── Privacy settings ──────────────────────────────────
    privacy_title:              'Privacidade',
    privacy_share_rsvps:        'Compartilhar RSVPs com amigos',
    privacy_share_rsvps_desc:   'Seus amigos podem ver os eventos que você confirmou',
    privacy_show_suggestions:   'Aparecer em sugestões de amizade',
    privacy_show_suggestions_desc: 'Outras pessoas podem encontrar seu perfil',
    privacy_show_profile:       'Perfil visível para não-amigos',
    privacy_show_profile_desc:  'Pessoas que não são seus amigos podem ver seu perfil completo',

    // ── Diagnostic ───────────────────────────────────────
    diag_header:            'Seu ponto de partida',
    diag_hello:             'Prazer,',
    diag_we_heard:          'Aqui está o que entendemos sobre você:',
    diag_social_before:     'Sua vida social antes',
    diag_feeling_now:       'Como você chega',
    diag_reason:            'O que te trouxe',
    diag_challenge:         'Seu maior desafio',
    diag_goal:              'Seu objetivo em 12 semanas',
    diag_prescription:      'Sua prescrição personalizada',
    diag_rx_line1:          'Começamos devagar: 1 evento por semana, sem pressão.',
    diag_rx_line2:          'Seu companheiro IA vai te guiar a cada passo.',
    diag_rx_line3:          'Tudo baseado em metodologia revisada por terapeutas.',
    diag_chapter:           'Seu primeiro capítulo',
    diag_begin:             'Começar minha jornada →',
    diag_feel_labels: {
      hopeful: 'Esperançosa mas nervosa',
      ready: 'Pronta — vamos nessa',
      tired: 'Cansada, mas tentando',
      skeptical: 'Cética, mas aberta',
      scared: 'Honestamente com medo',
    },
    diag_past_labels: {
      gallery_openings: 'Muito ativa socialmente',
      close_friends: 'Poucos amigos próximos',
      work_social: 'Trabalho era sua vida social',
      miss_it: 'Muito social — sente muita falta',
      never_right: 'Nunca foi bem assim',
    },
    diag_reason_labels: {
      gentle:    'Com calma, no meu ritmo',
      explorer:  'Explorando possibilidades',
      builder:   'Construindo vínculos reais',
      rebounder: 'Voltando ao jogo',
      depth:     'Profundidade sobre volume',
      steady:    'Com mais consistência',
      curious:   'Com curiosidade, sem agenda',
    },
    diag_challenge_labels: {
      starting: 'Começar conversas',
      groups: 'Conforto em grupos',
      myself: 'Se sentir ela mesma',
      consistent: 'Aparecer consistentemente',
      values: 'Encontrar pessoas certas',
    },
    diag_goal_labels: {
      friendships: '2–3 amizades de verdade',
      nodread: 'Ir a eventos sem ansiedade',
      comfortable: 'Conforto social',
      community: 'Comunidade local',
    },

    // ── PartnerIntro ──────────────────────────────────────
    partner_setting_up:     'Configurando seu',
    partner_companion_title:'companheiro reroot',
    partner_continue:       'Continuar →',
    partner_build:          'Criar meu companheiro →',
    partner_building_title: 'Criando seu companheiro...',
    partner_building_sub:   'Personalizando seu arco de 12 semanas',
    partner_companion_label:'Seu Companheiro Reroot',
    partner_companion_sub:  'IA · Metodologia revisada por terapeutas',
    partner_week1_label:    'Sua semana 1 começa com',
    partner_begin:          'Começar Semana 1 →',
    partner_building_btn:   'Criando...',
    partner_question_of:    'Pergunta',
    partner_takes:          'Leva 30 segundos',
    partner_skip:           'Pular',

    // ── Companion FAB ─────────────────────────────────────
    companion_fab_label:    'Companheiro',
    companion_fab_hint:     'Converse com seu companheiro',
    partner_week1_items: [
      { emoji: '📖', text: 'O Framework de Chegada — uma reflexão de 10 min' },
      { emoji: '☕', text: 'Um evento do cohort sem pressão' },
      { emoji: '🤝', text: 'Conhecer 3 pessoas do seu cohort' },
    ],
    partner_steps: [
      {
        id: 'reason',
        question: 'Como você prefere começar?',
        options: [
          { id: 'gentle',    label: 'Devagar — quero me acostumar antes de mergulhar', emoji: '🌿' },
          { id: 'explorer',  label: 'Quero experimentar coisas variadas',              emoji: '🧭' },
          { id: 'builder',   label: 'Foco em conhecer pessoas de verdade',             emoji: '🤝' },
          { id: 'rebounder', label: 'Estou pronto — me bota em campo',                emoji: '⚡' },
          { id: 'curious',   label: 'Sem agenda — vamos ver o que acontece',           emoji: '🔍' },
        ],
      },
      {
        id: 'challenge',
        question: 'O que está mais difícil agora?',
        options: [
          { id: 'starting',   label: 'Começar conversas',                  emoji: '💬' },
          { id: 'groups',     label: 'Me sentir confortável em grupos',     emoji: '👥' },
          { id: 'myself',     label: 'Me sentir eu mesmo novamente',        emoji: '🪞' },
          { id: 'consistent', label: 'Aparecer de forma consistente',       emoji: '📅' },
          { id: 'values',     label: 'Encontrar pessoas que me entendam',   emoji: '🤝' },
        ],
      },
      {
        id: 'goal',
        question: 'Em 12 semanas, quero...',
        options: [
          { id: 'friendships', label: 'Ter 2–3 amizades de verdade',       emoji: '🌱' },
          { id: 'nodread',     label: 'Ir a eventos sem ansiedade',         emoji: '✨' },
          { id: 'comfortable', label: 'Me sentir confortável socialmente',  emoji: '☀️' },
          { id: 'community',   label: 'Construir uma comunidade local',     emoji: '🏡' },
        ],
      },
    ],
    partner_messages: {
      gentle:    'Aparecer com calma já é aparecer. Vamos construir seu ritmo sem pressa.',
      explorer:  'Você está numa fase de descoberta — e isso é exatamente o combustível certo.',
      builder:   'Vínculos reais levam tempo e presença repetida. Esse é o plano.',
      rebounder: 'Você tem o instinto. Só precisamos do ponto de entrada certo.',
      curious:   'Curiosidade é o ativo mais subestimado na vida social. Você está bem equipado.',
      starting:   'Vou te introduzir em momentos estruturados — sem improvisação necessária.',
      groups:     'Começamos pequeno. Duas pessoas antes de vinte. O conforto cresce gradualmente.',
      myself:     'Os frameworks vão te ajudar a reconectar com como você realmente quer aparecer, sem precisar performar.',
      consistent: 'Cada semana tem um evento âncora — baixo risco, alto valor. Só uma coisa.',
      values:     'O modelo de cohort existe para isso. Essas não são pessoas estranhas. São pessoas na mesma fase.',
      friendships:'Na Semana 6, você vai saber exatamente quem são as suas pessoas.',
      nodread:    'Na Semana 4, aparecer começa a parecer uma escolha, não uma luta.',
      comfortable:'Conforto não é um destino — é o que acontece quando você para de se preparar para o pior.',
      community:  'Comunidade é construída um pequeno momento de cada vez. É literalmente isso que estamos fazendo.',
    },

    // ── Identity Mirror ───────────────────────────────────
    mirror_header:      'Antes de começar',
    mirror_step_situation_q: 'Como você quer se reconectar?',
    mirror_step_goal_q:      'O que você quer construir?',
    mirror_step1_q:     'Antes da pausa, sua vida social era...',
    mirror_step2_q:     'Chegando aqui hoje, você se sente...',
    mirror_continue:    'Continuar →',
    mirror_finish:      'Mostrar meu espelho →',
    mirror_question_of: 'Passo',
    mirror_affirmation_label: 'Seu ponto de partida',
    mirror_next_btn:    'Começar minha jornada →',
    mirror_step_situation_opts: [
      { id: 'gentle',    label: 'Quero voltar, mas com calma — menos é mais',              emoji: '🌿' },
      { id: 'explorer',  label: 'Estou numa fase nova e quero descobrir o que me anima', emoji: '🧭' },
      { id: 'builder',   label: 'Quero construir vínculos reais, não conexões rasas',   emoji: '🤝' },
      { id: 'rebounder', label: 'Estive fora por um tempo e estou pronto pra voltar',   emoji: '⚡' },
      { id: 'depth',     label: 'Prefiro poucas conexões, mas profundas',               emoji: '☕' },
      { id: 'steady',    label: 'Tenho tentado, mas não consigo manter o ritmo',        emoji: '📅' },
      { id: 'curious',   label: 'Quero experimentar coisas novas e ver onde leva',      emoji: '🔍' },
    ],
    mirror_step_goal_opts: [
      { id: 'friends',   label: 'Fazer amigos de verdade',       emoji: '🤝' },
      { id: 'partner',   label: 'Conhecer alguém especial',      emoji: '💛' },
      { id: 'community', label: 'Encontrar minha comunidade',    emoji: '🏡' },
      { id: 'self',      label: 'Me redescobrir antes de tudo',  emoji: '🌿' },
    ],
    mirror_situation_affirmations: {
      gentle:    'Reconexão não precisa ser intensa. Aparecer com calma é exatamente tão válido quanto aparecer com empolgação.',
      explorer:  'Fases novas pedem curiosidade, não respostas. Você está no lugar certo para descobrir.',
      builder:   'Vínculos reais não acontecem em volume — acontecem através de presença repetida. É exatamente isso que vamos construir.',
      rebounder: 'Você sabe como fazer isso — só precisa de um ponto de entrada. Vamos encontrar esse ponto juntos.',
      depth:     'Profundidade sobre amplitude é uma estratégia, não uma limitação. Poucas conexões fortes constroem mais do que muitas superficiais.',
      steady:    'Consistência não é força de vontade — é estrutura. Estamos aqui para montar essa estrutura com você.',
      curious:   'Não importa onde isso leva — importa que você está chegando com abertura. Isso é tudo que precisamos.',
    },
    mirror_step1_opts: [
      { id: 'gallery_openings', label: 'Muito ativa — eventos, amigos, saídas', emoji: '✨' },
      { id: 'close_friends',    label: 'Alguns amigos próximos, raramente saía', emoji: '☕' },
      { id: 'work_social',      label: 'Trabalho era minha vida social',          emoji: '💼' },
      { id: 'miss_it',          label: 'Era muito social — sinto muita falta',    emoji: '🌟' },
      { id: 'never_right',      label: 'Honestamente, nunca foi bem assim',       emoji: '🌫️' },
    ],
    mirror_step2_opts: [
      { id: 'hopeful',    label: 'Esperançosa mas nervosa',         emoji: '🌱' },
      { id: 'ready',      label: 'Pronta — vamos nessa',            emoji: '⚡' },
      { id: 'tired',      label: 'Cansada, mas tentando',           emoji: '🌙' },
      { id: 'skeptical',  label: 'Cética, mas aberta',              emoji: '🤔' },
      { id: 'scared',     label: 'Honestamente com medo',           emoji: '💭' },
    ],
    mirror_affirmations: {
      gallery_openings: 'Você já sabe como fazer isso. Estamos apenas reconstruindo o músculo.',
      close_friends:    'Profundidade sobre amplitude — essa é uma vantagem real aqui.',
      work_social:      'Há mais de você do que o trabalho permitiu aparecer. Esse é o espaço.',
      miss_it:          'Aquela pessoa ainda está aqui. Só precisa de um ambiente seguro para se mostrar.',
      never_right:      'Não precisamos recriar o passado. Podemos construir algo que realmente funcione para você.',
      hopeful:          'Esperança é tudo que precisamos para começar. O resto vem depois.',
      ready:            'Essa energia vai te levar longe. Canaliza ela para um evento de cada vez.',
      tired:            'Aparecer enquanto cansada é uma das formas mais corajosas de se mostrar.',
      skeptical:        'Ceticismo saudável está tudo bem. Deixa a experiência falar por si mesma.',
      scared:           'Medo é seu sistema nervoso te dizendo que isso importa. Isso é bom.',
    },

    // ── Home additions ────────────────────────────────────
    home_day_zero_title:   'Seu primeiro evento',
    home_day_zero_sub:     'Escolhemos algo com baixa pressão para te começar',
    home_day_zero_save:    'Salvar meu lugar →',
    home_day_zero_saved:   'Você vai! ✓',
    home_day_zero_going:   'Lugar salvo',
    home_chapter_label:    'Seu capítulo atual',
    home_rx_refreshes:     'Prescrição atualiza em',
    home_rx_days:          'dias (Segunda-feira)',
    home_rx_fresh:         'Prescrição fresca esta semana!',
    home_reflect_title:    'Como foi?',
    home_reflect_sub:      'Você confirmou presença. Gostaríamos de saber.',
    home_reflect_btn:      'Adicionar reflexão',
    home_reflect_modal_title: 'Uma palavra para descrever isso',
    home_reflect_placeholder: 'ex: esperançosa, nervosa, surpresa...',
    home_reflect_save:     'Salvar reflexão',
    home_reflect_cancel:   'Agora não',
    home_month_title:      'Março em retrospecto',
    home_month_sub:        'Veja até onde você chegou',
    home_month_dismiss:    'Entendido',
    home_month_share:      'Compartilhar',

    // ── Profile additions ─────────────────────────────────
    profile_week_label:    'Esta semana',
    profile_week_shown:    'dias apareceu',
    profile_journal_label: 'Suas reflexões',
    profile_journal_empty: 'Suas reflexões vão aparecer aqui depois de eventos.',
    profile_pause_btn:     'Gerenciar assinatura',
    profile_pause_title:   'Gerenciar assinatura',
    profile_pause_option:  'Pausar por 2 semanas',
    profile_pause_sub:     'Retoma automaticamente. Sem perder seu progresso.',
    profile_cancel_option: 'Cancelar assinatura',
    profile_cancel_sub:    'Você perderá acesso ao cohort e frameworks.',
    profile_paused_badge:  '⏸ Pausado — retoma em 2 semanas',
    profile_close:         'Fechar',
    profile_redo_onboarding: '↺ Refazer onboarding',

    // ── User profiles ─────────────────────────────────────
    diag_profile_label: 'Seu perfil',
    diag_goal_label:    'Seu objetivo',
    profiles: {
      gentle: {
        name: 'Passo a Passo', tag: 'Reconexão no seu ritmo',
        rx1: 'Um evento por semana — escolhido com cuidado, sem pressão de desempenho.',
        rx2: 'Começamos com atividades solo-friendly antes de grupos.',
        rx3: 'Metodologia de exposição gradual revisada por terapeutas.',
        companion: 'Reconexão não precisa ser intensa. Aparecer com calma é exatamente tão válido quanto aparecer com empolgação.',
      },
      explorer: {
        name: 'Explorando', tag: 'Descobrindo o que te anima',
        rx1: 'Dois eventos por semana — variados, para mapear o que ressoa.',
        rx2: 'Prioridade: experiências novas onde você não precisa ser expert.',
        rx3: 'Framework de autodescoberta por experimentação social.',
        companion: 'Fases novas pedem curiosidade, não respostas. Você está no lugar certo para descobrir.',
      },
      builder: {
        name: 'Construindo Vínculos', tag: 'Conexões reais, não superficiais',
        rx1: 'Dois eventos por semana em ambientes onde os mesmos rostos aparecem.',
        rx2: 'Presença repetida é o ingrediente principal de amizades verdadeiras.',
        rx3: 'Metodologia de construção de comunidade revisada por terapeutas.',
        companion: 'Vínculos reais não acontecem em volume — acontecem através de presença repetida. É exatamente isso que vamos construir.',
      },
      rebounder: {
        name: 'Voltando ao Jogo', tag: 'Você sabe como isso funciona',
        rx1: 'Dois eventos por semana — energia alta, ambiente social ativo.',
        rx2: 'Foco em eventos onde a barreira de entrada é baixa mas o retorno é alto.',
        rx3: 'Protocolo de reentrada para quem está pronto para acelerar.',
        companion: 'Você sabe como fazer isso — só precisa de um ponto de entrada. Vamos encontrar esse ponto juntos.',
      },
      depth: {
        name: 'Qualidade sobre Volume', tag: 'Poucas conexões, mas de verdade',
        rx1: 'Um evento por semana — ambientes pequenos onde conversas reais acontecem.',
        rx2: 'Sem eventos de multidão. Prioridade total: tamanho pequeno, contexto compartilhado.',
        rx3: 'Framework focado em profundidade de conexão, não em volume.',
        companion: 'Profundidade sobre amplitude é uma estratégia, não uma limitação. Poucas conexões fortes constroem mais do que muitas superficiais.',
      },
      steady: {
        name: 'Com Consistência', tag: 'Estrutura que sustenta o ritmo',
        rx1: 'Um evento por semana — o mesmo dia, o mesmo tipo de ambiente.',
        rx2: 'Consistência não é força de vontade. É a estrutura que vamos construir juntos.',
        rx3: 'Metodologia de hábito social revisada por terapeutas.',
        companion: 'Consistência não é força de vontade — é estrutura. Estamos aqui para montar essa estrutura com você.',
      },
      curious: {
        name: 'Com Curiosidade', tag: 'Aberto para onde isso leva',
        rx1: 'Dois eventos por semana — um familiar, um desconhecido.',
        rx2: 'A curiosidade é o ativo. Não precisamos saber o destino.',
        rx3: 'Framework de expansão por interesse genuíno.',
        companion: 'Não importa onde isso leva — importa que você está chegando com abertura. Isso é tudo que precisamos.',
      },
    },
    goals: {
      friends:   { label: 'Amizades de verdade',      emoji: '🤝' },
      partner:   { label: 'Conhecer alguém especial', emoji: '💛' },
      community: { label: 'Minha comunidade',          emoji: '🏡' },
      self:      { label: 'Me redescobrir',            emoji: '🌿' },
    },

    // ── Weekly check-in ───────────────────────────────────
    home_checkin_label:   'Check-in da semana passada',
    home_checkin_q:       'Como foi a semana',
    home_checkin_sub:     'Sua resposta nos ajuda a sugerir o que vem a seguir.',
    home_checkin_saved:   'Anotado ✓',
    home_checkin_saved_sub: 'Aqui estão as sugestões para esta semana:',
    home_checkin_emojis:  ['😰', '😐', '🙂', '😊', '🎉'],
    home_checkin_emo_lbl: ['Difícil', 'Mais ou menos', 'Bem', 'Ótimo', 'Incrível!'],

    // ── Activity ideas ────────────────────────────────────
    home_activities_label: 'Ideias para você',
    home_activities_sub:   'Atividades solo-friendly em Curitiba',
    home_activities_sub_first: 'Comece por aqui — antes de eventos em grupo',
    home_activity_reroot:  'Por que é bom agora',
    home_activity_solo:    '✓ Solo-friendly',
    home_activity_free:    'Grátis',

    // ── Event-day banner ──────────────────────────────────
    home_event_today_label: 'Você tem um evento esta semana',
    home_event_today_sub:   'Boa sorte — você vai arrasar.',
    home_event_today_view:  'Ver detalhes →',

    // ── Notification toast ────────────────────────────────
    home_notif_confirmed:  '🔔 Lembrete salvo',

    // ── Post-event attendees ─────────────────────────────
    people_you_met:     'Pessoas que você conheceu',
    connect:            'Conectar',
    already_friends:    'Amigos',
    no_attendees:       'Nenhum participante encontrado',
    connecting:         'Conectando...',
    connect_sent:       'Enviado!',

    // ── Accessibility ─────────────────────────────────────
    accessibility_mode:        'Modo Acessível',
    accessibility_description: 'Textos maiores e botões mais fáceis de tocar',
  },
}

// EN mirrors PT — single source of truth
T.en = { ...T.pt }

// EN overrides for post-event attendees
T.en.people_you_met = 'People you met'
T.en.connect = 'Connect'
T.en.already_friends = 'Friends'
T.en.no_attendees = 'No attendees found'
T.en.connecting = 'Connecting...'
T.en.connect_sent = 'Sent!'

// EN overrides for accessibility
T.en.accessibility_mode = 'Accessibility Mode'
T.en.accessibility_description = 'Larger text and easier-to-tap buttons'

// EN overrides for privacy settings
T.en.privacy_title = 'Privacy'
T.en.privacy_share_rsvps = 'Share RSVPs with friends'
T.en.privacy_share_rsvps_desc = 'Your friends can see events you confirmed'
T.en.privacy_show_suggestions = 'Appear in friend suggestions'
T.en.privacy_show_suggestions_desc = 'Other people can find your profile'
T.en.privacy_show_profile = 'Profile visible to non-friends'
T.en.privacy_show_profile_desc = 'Non-friends can see your full profile'

// EN overrides for curated filter
T.en.filter_hide_curated = 'Real only'
T.en.filter_hide_curated_on = 'No AI suggestions'

// EN overrides for curated/private event badges
T.en.tag_curated = 'AI Suggestion'
T.en.tag_curated_long = 'AI-curated suggestion — not a real event'
T.en.tag_private = 'My event'
T.en.tag_private_long = 'Private event created by you'

// ── Hook ──────────────────────────────────────────────────
import { useApp } from '../context/AppContext'

export function useT() {
  const { state } = useApp()
  return T[state.language ?? 'pt']
}
