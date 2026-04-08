"""
Pipeline de enriquecimento via Claude.

Para cada RawEvent, o Claude extrai:
  - Categoria Reroot (quiet_social / active / creative / community)
  - Tem comida?
  - É low-pressure (bom para re-entrada social)?
  - Faixa de preço
  - Resumo de vibe
  - Tamanho esperado
  - good_for_reroot: bool com justificativa

Portfolio signal: isso é um LLM enrichment pipeline — pattern muito pedido
em entrevistas de analytics engineering + AI engineering.
"""
import json
import logging
import re
from datetime import datetime, timezone
from anthropic import Anthropic
from models import RawEvent, EnrichedEvent

log = logging.getLogger(__name__)

# Gradientes CSS por categoria — consistência com o design do app
CATEGORY_GRADIENTS = {
    "quiet_social": "linear-gradient(135deg, #F5DDD1, #EDCBB8)",
    "active":       "linear-gradient(135deg, #E8EAF6, #C8CBE9)",
    "creative":     "linear-gradient(135deg, #E4EFE5, #CDDECE)",
    "community":    "linear-gradient(135deg, #FFF3E0, #FFE0B2)",
}

CATEGORY_META = {
    "quiet_social": ("🌿", "Encontro Tranquilo"),
    "active":       ("🏃", "Ativo"),
    "creative":     ("🎨", "Criativo"),
    "community":    ("🤝", "Comunidade"),
}

ENRICHMENT_PROMPT = """\
Você analisa eventos sociais para o Reroot — um app de recuperação social para pessoas \
(principalmente mulheres 35-55) reconstruindo vida social após divórcio ou transição importante. \
O foco é eventos de baixa pressão, ambiente íntimo, onde aparecer já é suficiente.

EVENTO:
Nome: {name}
Descrição: {description}
Local: {venue_name} — {venue_address}
Data: {date}
Preço: {price}
Capacidade estimada: {capacity}
Confirmados: {confirmed}

Responda SOMENTE com JSON válido (sem markdown, sem texto extra):
{{
  "reroot_category": "quiet_social" | "active" | "creative" | "community",
  "has_food": true | false,
  "is_low_pressure": true | false,
  "good_for_reroot": true | false,
  "reroot_reason": "<frase curta em português explicando por que é bom ou ruim para re-entrada social>",
  "price_tier": "free" | "low" | "medium" | "high",
  "vibe_summary": "<frase de 1 linha descrevendo a experiência, em português>",
  "expected_size": "small" | "medium" | "large",
  "neighborhood_guess": "<bairro de Curitiba ou vazio se não souber>"
}}

Critérios:
- quiet_social: cafés, caminhadas, encontros pequenos, rodas de conversa
- active: yoga, esportes, dança, trilha
- creative: oficinas, escrita, fotografia, pintura, teatro
- community: feiras, voluntariado, eventos de bairro
- good_for_reroot = true se: ambiente acolhedor, grupos pequenos-médios, não exige performance social
- good_for_reroot = false se: balada, evento de networking agressivo, show lotado, festival
- price_tier: free=R$0, low=até R$50, medium=R$50-150, high=acima de R$150
- expected_size: small=<30, medium=30-200, large=200+
"""


class EnrichmentPipeline:
    def __init__(self, api_key: str):
        self.client = Anthropic(api_key=api_key)

    def enrich(self, raw: RawEvent) -> EnrichedEvent | None:
        """Enriquece um único evento. Retorna None se Claude falhar."""
        price_str = (
            "Gratuito" if raw.price_min == 0 and raw.price_max == 0
            else f"R$ {raw.price_min:.0f}" if raw.price_min == raw.price_max
            else f"R$ {raw.price_min:.0f} – {raw.price_max:.0f}"
        )

        prompt = ENRICHMENT_PROMPT.format(
            name=raw.name,
            description=raw.description or "(sem descrição)",
            venue_name=raw.venue_name,
            venue_address=raw.venue_address,
            date=raw.date_start.strftime("%d/%m/%Y %H:%M"),
            price=price_str,
            capacity=raw.capacity or "desconhecida",
            confirmed=raw.attendees_confirmed or "desconhecido",
        )

        try:
            response = self.client.messages.create(
                model="claude-haiku-4-5-20251001",   # Haiku: rápido e barato para extração estruturada
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            raw_json = response.content[0].text.strip()
            # Strip markdown fences if Claude wrapped the JSON
            raw_json = re.sub(r"^```(?:json)?\s*", "", raw_json)
            raw_json = re.sub(r"\s*```$", "", raw_json)
            data = json.loads(raw_json)
        except json.JSONDecodeError as e:
            log.warning(f"Claude retornou JSON inválido para '{raw.name}': {e}")
            return None
        except Exception as e:
            log.error(f"Claude API error para '{raw.name}': {e}")
            return None

        category = data.get("reroot_category", "community")
        emoji, label = CATEGORY_META.get(category, ("🤝", "Comunidade"))
        gradient = CATEGORY_GRADIENTS.get(category, CATEGORY_GRADIENTS["community"])

        neighborhood = (
            data.get("neighborhood_guess")
            or raw.neighborhood
            or raw.city
        )

        return EnrichedEvent(
            id=f"{raw.source}_{raw.external_id}",
            source=raw.source,
            external_id=raw.external_id,
            name=raw.name,
            description=raw.description,
            venue_name=raw.venue_name,
            venue_address=raw.venue_address,
            neighborhood=neighborhood,
            city=raw.city,
            date_start=raw.date_start,
            date_end=raw.date_end,
            price_min=raw.price_min,
            price_max=raw.price_max,
            currency=raw.currency,
            capacity=raw.capacity,
            attendees_confirmed=raw.attendees_confirmed or 0,

            reroot_category=category,
            category_label=label,
            category_emoji=emoji,
            has_food=data.get("has_food", False),
            is_low_pressure=data.get("is_low_pressure", True),
            good_for_reroot=data.get("good_for_reroot", False),
            reroot_reason=data.get("reroot_reason", ""),
            price_tier=data.get("price_tier", "free"),
            vibe_summary=data.get("vibe_summary", raw.name),
            expected_size=data.get("expected_size", "medium"),
            header_gradient=gradient,

            url=raw.url,
            image_url=raw.image_url,
            fetched_at=raw.date_start.replace(day=raw.date_start.day),  # placeholder
            enriched_at=datetime.now(timezone.utc),
        )

    def enrich_batch(self, raws: list[RawEvent], max_events: int = 40) -> list[EnrichedEvent]:
        """
        Enriquece um lote. Limita a `max_events` para controlar custo de API.
        Claude Haiku custa ~$0.001 por evento — 40 eventos = ~$0.04.
        """
        results = []
        skipped = 0

        for raw in raws[:max_events]:
            enriched = self.enrich(raw)
            if enriched:
                results.append(enriched)
            else:
                skipped += 1

        log.info(f"Enriquecimento: {len(results)} ok, {skipped} falhas (de {min(len(raws), max_events)} tentativas)")
        return results
