"""
Seed the database with curated Reroot Original suggestions.

These are NOT scheduled events. They are evergreen activity ideas at real
Curitiba venues — go when you want, alone or with someone. We surface them
alongside scraped events so the catalog is never empty, but they're tagged
`source="aue_original"` and rendered with a "Sempre disponível" badge so
no user mistakes them for a meetup with a fixed time.

Run: py -3.12 seed_events.py
"""
from datetime import datetime, timedelta, timezone
from models import EnrichedEvent
import database as db

NOW = datetime.now(timezone.utc)


def make_event(
    idx, name, desc, venue, address, neighborhood, category,
    label, emoji, gradient, has_food, low_pressure, reason, vibe, image=None,
):
    # date_start is a placeholder one year out — these are evergreen ideas, not
    # scheduled events. The frontend overrides the date/time display.
    start = NOW + timedelta(days=365)
    return EnrichedEvent(
        id=f"aue_original_{idx}",
        source="aue_original",
        external_id=f"original_{idx}",
        name=name,
        description=desc,
        venue_name=venue,
        venue_address=address,
        neighborhood=neighborhood,
        city="Curitiba",
        date_start=start,
        date_end=None,
        price_min=0.0,
        price_max=0.0,
        currency="BRL",
        capacity=0,
        attendees_confirmed=0,
        kind=category,
        category_label=label,
        category_emoji=emoji,
        has_food=has_food,
        is_low_pressure=low_pressure,
        is_curated=True,
        pitch=reason,
        price_tier="free",
        vibe_summary=vibe,
        expected_size="small",
        header_gradient=gradient,
        url="",  # backend falls back to a Google Maps search for the venue
        image_url=image,
        fetched_at=NOW,
        enriched_at=NOW,
    )


SEED_EVENTS = [
    make_event(
        1,
        "Caminhar no Jardim Botânico",
        "Vá ao Jardim Botânico em qualquer manhã. Faça o circuito da estufa, pare no café da entrada. Sem pressa, sem objetivo — só estar fora.",
        "Jardim Botânico", "Rua Engenheiro Ostoja Roguski, s/n", "Jardim Botânico",
        "quiet_social", "Encontro Tranquilo", "🌿",
        "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
        False, True,
        "Espaço aberto e movimentado o suficiente pra você não se sentir exposto. Bom para a primeira saída.",
        "Caminhada solo num cartão-postal de Curitiba",
    ),
    make_event(
        2,
        "Pintar aquarela em São Francisco",
        "Procure um ateliê de aquarela no bairro São Francisco. Várias casas oferecem aulas avulsas para iniciantes — mãos na tinta, conversa opcional.",
        "Ateliês de São Francisco", "Rua Trajano Reis e arredores", "São Francisco",
        "creative", "Criativo", "🎨",
        "linear-gradient(135deg, #E4EFE5, #CDDECE)",
        False, True,
        "Atividade guiada e com material nas mãos: você não precisa puxar assunto, o processo cuida disso.",
        "Bairro com vários ateliês — escolha um e peça uma aula avulsa",
    ),
    make_event(
        3,
        "Yoga no Parque Barigui",
        "Aos finais de semana o Barigui tem grupos abertos de yoga e tai chi. Apareça com um tapete, fique no fundo, ninguém vai reparar se você for embora antes.",
        "Parque Barigui", "Av. Cândido Hartmann, s/n", "Santo Inácio",
        "active", "Ativo", "🏃",
        "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
        False, True,
        "Prática individual em grupo: você pode estar completamente em silêncio e ainda assim 'estar com gente'.",
        "Yoga aberto ao público com vista pro lago",
    ),
    make_event(
        4,
        "Café com Jogos: jogar tabuleiro",
        "O Café com Jogos no Alto da XV tem prateleiras com centenas de jogos. Vá sozinho, peça um jogo cooperativo no balcão e jogue com quem aparecer na mesa.",
        "Café com Jogos", "Rua Fernando Amaro, 170", "Alto da XV",
        "community", "Comunidade", "🤝",
        "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        True, True,
        "Jogo dá estrutura natural pra interação. Você não precisa improvisar conversa — as regras já estão prontas.",
        "Bar de jogos onde mesas se misturam",
    ),
    make_event(
        5,
        "Levar um livro pro Café Lucca",
        "Vai ao Café Lucca do Centro num final de tarde, leva um livro, pede um café e fica. Mesas comunitárias acabam virando conversa quando dá vontade.",
        "Café Lucca", "Rua Kellers, 95", "Centro",
        "quiet_social", "Encontro Tranquilo", "🌿",
        "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
        True, True,
        "Ler num café é o exemplo clássico de 'sozinho mas acompanhado'. Zero exigência social.",
        "Café histórico no Centro com mesas amplas",
    ),
    make_event(
        6,
        "Aula avulsa de cerâmica",
        "Vários ateliês em São Francisco e Mercês oferecem aulas-experiência de cerâmica no torno. Procure no Instagram por 'cerâmica Curitiba' e marca uma.",
        "Ateliês de cerâmica", "São Francisco / Mercês", "São Francisco",
        "creative", "Criativo", "🎨",
        "linear-gradient(135deg, #E4EFE5, #CDDECE)",
        False, True,
        "Grupos pequenos e atividade absorvente. Quem está voltando a socializar costuma se dar bem aqui.",
        "Mãos na argila em ateliê pequeno",
    ),
    make_event(
        7,
        "Trilha no Parque Tanguá",
        "O Tanguá tem uma trilha curta com mirante e túnel pelas pedreiras. Vai cedo, leva água. Dá pra fazer em 1h sozinho ou em grupo.",
        "Parque Tanguá", "R. Oswaldo Maciel, s/n", "Pilarzinho",
        "active", "Ativo", "🏃",
        "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
        False, True,
        "Caminhar lado a lado é o formato menos intimidante de socializar — e o cenário facilita parar pra fotos.",
        "Trilha curta com mirante panorâmico",
    ),
    make_event(
        8,
        "Feira do Largo da Ordem (sábado e domingo)",
        "A feira do Largo da Ordem acontece todo fim de semana. Artesanato, música ao vivo, pastel de feira. Anda sem rumo, conversa com quem vende — é o tipo de espaço onde puxar conversa não é estranho.",
        "Largo da Ordem", "Largo Coronel Enéas, Centro Histórico", "Centro Histórico",
        "community", "Comunidade", "🤝",
        "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        True, True,
        "Feira livre permite ir e vir no seu ritmo. Conversas acontecem nas bancas naturalmente.",
        "Sabores e artesanato no centro histórico",
    ),
    make_event(
        9,
        "Fotografar o Centro Histórico",
        "Saia com o celular pelo Centro Histórico — Largo da Ordem, Paço da Liberdade, Catedral. Foto é desculpa pra olhar com mais atenção e ficar mais tempo num lugar.",
        "Centro Histórico", "Largo da Ordem e arredores", "Centro Histórico",
        "creative", "Criativo", "🎨",
        "linear-gradient(135deg, #E4EFE5, #CDDECE)",
        False, True,
        "Foco numa atividade dá propósito ao passeio solo. Socializar, se rolar, é efeito colateral.",
        "Passeio fotográfico pelo coração antigo de Curitiba",
    ),
    make_event(
        10,
        "Espaços de meditação no Batel",
        "Curitiba tem alguns centros de meditação Vipassana, Zen e Mindfulness no Batel e Bigorrilho com sessões abertas semanais. Procure 'meditação aberta Curitiba' e escolha um.",
        "Centros de meditação", "Batel / Bigorrilho", "Batel",
        "quiet_social", "Encontro Tranquilo", "🌿",
        "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
        False, True,
        "Meditação é socialização sem demanda — você está com pessoas, mas o protocolo é o silêncio.",
        "Silêncio compartilhado em grupo pequeno",
    ),
    make_event(
        11,
        "Pedalar pela Ciclovia do Parque Linear",
        "O Parque Linear Cajuru tem ciclovia plana de 12km, perfeita pra pedal calmo. Tem bicicletário público e quiosques no caminho.",
        "Parque Linear Cajuru", "Av. Comendador Franco", "Cajuru",
        "active", "Ativo", "🏃",
        "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
        False, True,
        "Pedalar lado a lado: dá pra conversar sem o peso do olho-no-olho.",
        "Ciclovia plana pra um pedal sem pressão",
    ),
    make_event(
        12,
        "Voluntariar em horta comunitária",
        "Curitiba tem um programa de hortas urbanas com mutirões abertos aos sábados. Procure 'horta urbana Curitiba' na prefeitura ou no Instagram para encontrar a mais próxima.",
        "Hortas urbanas de Curitiba", "Diversos bairros", "Cajuru / Pinheirinho / outros",
        "community", "Comunidade", "🤝",
        "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        True, True,
        "Trabalho manual em grupo cria conexão sem exigir habilidade social. O propósito compartilhado faz o trabalho.",
        "Plante junto, leve verduras pra casa",
    ),
]


def seed():
    db.init_db()
    # Drop any previous originals (under any historical source name) so
    # renames take effect cleanly.
    import sqlite3
    with sqlite3.connect(db.DB_PATH) as conn:
        conn.execute("DELETE FROM events WHERE source IN ('aue_original', 'reroot_original')")
        # Also clean up the old fake-Sympla seeds from earlier runs.
        conn.execute(
            "DELETE FROM events WHERE source = 'sympla' AND external_id LIKE 'seed_%'"
        )
        conn.commit()
    for ev in SEED_EVENTS:
        db.upsert_event(ev)
    print(f"Seeded {len(SEED_EVENTS)} Originais auê into {db.DB_PATH}")


if __name__ == "__main__":
    seed()
