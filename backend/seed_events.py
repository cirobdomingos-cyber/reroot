"""
Seed the database with realistic events for development/demo.
Run: py -3.12 seed_events.py
"""
from datetime import datetime, timedelta, timezone
from models import EnrichedEvent
import database as db

NOW = datetime.now(timezone.utc)


def make_event(
    idx, source, name, desc, venue, address, neighborhood, category,
    label, emoji, gradient, price_min, price_max, tier,
    days_ahead, hour, duration_h, size, attendees,
    has_food, low_pressure, good, reason, vibe, image=None,
):
    start = (NOW + timedelta(days=days_ahead)).replace(hour=hour, minute=0, second=0)
    end = start + timedelta(hours=duration_h)
    return EnrichedEvent(
        id=f"{source}_seed_{idx}",
        source=source,
        external_id=f"seed_{idx}",
        name=name,
        description=desc,
        venue_name=venue,
        venue_address=address,
        neighborhood=neighborhood,
        city="Curitiba",
        date_start=start,
        date_end=end,
        price_min=price_min,
        price_max=price_max,
        currency="BRL",
        capacity=attendees * 3,
        attendees_confirmed=attendees,
        reroot_category=category,
        category_label=label,
        category_emoji=emoji,
        has_food=has_food,
        is_low_pressure=low_pressure,
        good_for_reroot=good,
        reroot_reason=reason,
        price_tier=tier,
        vibe_summary=vibe,
        expected_size=size,
        header_gradient=gradient,
        url=f"https://example.com/event/{idx}",
        image_url=image,
        fetched_at=NOW,
        enriched_at=NOW,
    )


SEED_EVENTS = [
    make_event(
        1, "sympla",
        "Caminhada Matinal no Jardim Botânico",
        "Caminhada leve pelo Jardim Botânico de Curitiba com parada para café. Sem pressa, sem exigências — só aparecer já é suficiente. Grupo pequeno e acolhedor.",
        "Jardim Botânico", "Rua Engenheiro Ostoja Roguski, s/n", "Jardim Botânico",
        "quiet_social", "Encontro Tranquilo", "🌿",
        "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
        0, 0, "free", 3, 9, 2, "small", 12,
        False, True, True,
        "Ambiente aberto e sem pressão — caminhar lado a lado facilita conversa natural",
        "Passeio tranquilo com café no final",
    ),
    make_event(
        2, "sympla",
        "Oficina de Aquarela para Iniciantes",
        "Oficina de aquarela em grupo pequeno. Todo material incluso. Não precisa ter experiência — o processo importa mais que o resultado.",
        "Ateliê Cores Vivas", "Rua Trajano Reis, 280", "São Francisco",
        "creative", "Criativo", "🎨",
        "linear-gradient(135deg, #E4EFE5, #CDDECE)",
        45, 45, "low", 5, 14, 3, "small", 8,
        False, True, True,
        "Atividade guiada remove a pressão de socializar — você tem algo para fazer com as mãos",
        "Pinte sem julgamento em grupo íntimo",
    ),
    make_event(
        3, "sympla",
        "Yoga ao Ar Livre no Parque Barigui",
        "Aula de yoga para todos os níveis no Parque Barigui. Traga seu tapete ou pegue um emprestado. Silêncio é bem-vindo.",
        "Parque Barigui", "Rodovia BR-277, s/n", "Santo Inácio",
        "active", "Ativo", "🏃",
        "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
        0, 0, "free", 6, 8, 1.5, "medium", 25,
        False, True, True,
        "Prática individual em grupo — você pode ser completamente silencioso e tudo bem",
        "Yoga suave com vista para o lago",
    ),
    make_event(
        4, "sympla",
        "Noite de Jogos de Tabuleiro",
        "Jogos de tabuleiro modernos com explicação para iniciantes. A estrutura do jogo tira o peso da conversa — você tem algo concreto para fazer.",
        "Café com Jogos", "Rua Fernando Amaro, 170", "Alto da XV",
        "community", "Comunidade", "🤝",
        "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        0, 0, "free", 7, 19, 3, "medium", 18,
        True, True, True,
        "Jogos dão estrutura natural para interação — sem small talk forçado",
        "Diversão estruturada com petiscos",
    ),
    make_event(
        5, "sympla",
        "Roda de Leitura no Café",
        "Traga o livro que está lendo ou escolha um na estante. Lemos juntos em silêncio por 1h, depois compartilhamos (quem quiser). Café incluso.",
        "Café Lucca", "Rua Kellers, 95", "Centro",
        "quiet_social", "Encontro Tranquilo", "🌿",
        "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
        0, 0, "free", 10, 16, 2, "small", 10,
        True, True, True,
        "Ler junto é social sem ser exigente — zero pressão para falar",
        "Leitura silenciosa acompanhada de café",
    ),
    make_event(
        6, "sympla",
        "Aula Experimental de Cerâmica",
        "Primeira aula gratuita de cerâmica no torno. Grupos de até 6 pessoas. Mãos na argila, música baixa, conversa opcional.",
        "Ateliê Terra", "Rua Mateus Leme, 560", "São Francisco",
        "creative", "Criativo", "🎨",
        "linear-gradient(135deg, #E4EFE5, #CDDECE)",
        0, 0, "free", 8, 10, 2.5, "small", 5,
        False, True, True,
        "Grupo muito pequeno e atividade absorvente — ideal para quem está voltando a socializar",
        "Mãos na argila em grupo íntimo",
    ),
    make_event(
        7, "sympla",
        "Trilha Leve no Parque Tanguá",
        "Trilha de 4km com ritmo tranquilo. Guia aponta flora nativa. Parada para fotos e conversa no mirante.",
        "Parque Tanguá", "Rua Oswaldo Maciel, s/n", "Pilarzinho",
        "active", "Ativo", "🏃",
        "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
        0, 0, "free", 4, 7, 3, "small", 15,
        False, True, True,
        "Caminhar em grupo pequeno com foco na natureza — conversa acontece naturalmente",
        "Trilha guiada com vista panorâmica",
    ),
    make_event(
        8, "sympla",
        "Feira de Produtores do Batel",
        "Feira semanal com produtores locais. Frutas, pães artesanais, café coado na hora. Ambiente descontraído para passear e conversar.",
        "Praça do Batel", "Praça General Osório", "Batel",
        "community", "Comunidade", "🤝",
        "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        0, 0, "free", 2, 8, 4, "medium", 45,
        True, True, True,
        "Feira livre permite ir e vir no seu ritmo — conversa acontece naturalmente nas bancas",
        "Sabores locais em clima de vizinhança",
    ),
    make_event(
        9, "sympla",
        "Workshop de Fotografia com Celular",
        "Aprenda composição e luz usando só o celular. Passeio fotográfico pelo centro histórico em grupo pequeno.",
        "Largo da Ordem", "Largo da Ordem, s/n", "Centro Histórico",
        "creative", "Criativo", "🎨",
        "linear-gradient(135deg, #E4EFE5, #CDDECE)",
        30, 30, "low", 12, 14, 3, "small", 10,
        False, True, True,
        "Foco na atividade dá propósito ao passeio — socialização é efeito colateral natural",
        "Fotografe o centro histórico com novo olhar",
    ),
    make_event(
        10, "sympla",
        "Meditação Guiada ao Pôr do Sol",
        "Meditação guiada de 40min seguida de chá. Espaço acolhedor, almofadas confortáveis. Pode ir embora quando quiser.",
        "Espaço Florescer", "Rua Visconde de Guarapuava, 4020", "Batel",
        "quiet_social", "Encontro Tranquilo", "🌿",
        "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
        25, 25, "low", 9, 18, 1.5, "small", 8,
        False, True, True,
        "Meditação é intrinsecamente sem pressão — ideal para quem quer companhia sem demanda social",
        "Silêncio compartilhado com chá no final",
    ),
    make_event(
        11, "sympla",
        "Pedal Leve pela Ciclovia",
        "Passeio de bicicleta de 12km pela ciclovia do Parque Linear. Ritmo tranquilo, paradas para descanso. Traga sua bike ou alugue uma.",
        "Parque Linear Cajuru", "Av. Comendador Franco", "Cajuru",
        "active", "Ativo", "🏃",
        "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
        0, 0, "free", 5, 7, 2, "small", 14,
        False, True, True,
        "Pedalar em grupo permite conversa casual sem olho no olho — menos intimidante",
        "Pedal tranquilo pela ciclovia",
    ),
    make_event(
        12, "sympla",
        "Voluntariado no Jardim Comunitário",
        "Ajude a plantar e cuidar da horta comunitária. Luvas e ferramentas fornecidas. Termine o dia com um lanche coletivo.",
        "Horta Comunitária Cajuru", "Rua Profª Hilda Cadilhe de Oliveira", "Cajuru",
        "community", "Comunidade", "🤝",
        "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        0, 0, "free", 11, 9, 3, "small", 12,
        True, True, True,
        "Trabalho manual em grupo cria conexão sem exigir habilidade social — propósito compartilhado",
        "Plante junto e leve verduras para casa",
    ),
]


def seed():
    db.init_db()
    for ev in SEED_EVENTS:
        db.upsert_event(ev)
    print(f"Seeded {len(SEED_EVENTS)} events into {db.DB_PATH}")


if __name__ == "__main__":
    seed()
