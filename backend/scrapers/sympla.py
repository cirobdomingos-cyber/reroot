"""
Sympla Public API v3
Docs: https://developers.sympla.com.br/
Token gratuito: cadastre-se em developers.sympla.com.br e gere um s_token.

Endpoint relevante:
  GET https://api.sympla.com.br/public/v3/events
  Headers: s_token: <seu_token>
  Params: page, size, from (YYYY-MM-DD), to (YYYY-MM-DD)
"""
import httpx
import logging
from datetime import datetime, timedelta
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://api.sympla.com.br/public/v3"
# Categorias Sympla que fazem sentido para o Reroot
RELEVANT_CATEGORIES = {
    "workshop", "curso", "palestra", "esportes", "dança",
    "gastronomia", "artes", "teatro", "música", "literatura",
    "bem-estar", "yoga", "meditação", "fotografia", "artesanato",
}


async def fetch_events(token: str, city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    """Busca eventos para os próximos `days_ahead` dias, filtrados por cidade."""
    if not token:
        log.warning("SYMPLA_TOKEN não configurado — pulando Sympla.")
        return []

    date_from = datetime.now().strftime("%Y-%m-%d")
    date_to   = (datetime.now() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")

    all_events: list[RawEvent] = []
    page = 1

    async with httpx.AsyncClient(timeout=15) as client:
        while True:
            try:
                resp = await client.get(
                    f"{BASE_URL}/events",
                    headers={"s_token": token},
                    params={
                        "page": page,
                        "size": 50,
                        "from": date_from,
                        "to":   date_to,
                    },
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                log.error(f"Sympla HTTP error: {e.response.status_code} — {e.response.text[:200]}")
                break
            except Exception as e:
                log.error(f"Sympla request failed: {e}")
                break

            data = resp.json()
            items = data.get("data", [])
            if not items:
                break

            for item in items:
                parsed = _parse(item)
                if parsed:
                    # Accept event if city matches or if no city filter
                    if not city or parsed.city.lower() == city.lower():
                        all_events.append(parsed)

            # Sympla uses page-based pagination
            total_pages = data.get("pagination", {}).get("totalPage", 1)
            if page >= total_pages:
                break
            page += 1

    log.info(f"Sympla: {len(all_events)} eventos encontrados (city filter: {city or 'any'})")
    return all_events


def _parse(item: dict) -> RawEvent | None:
    try:
        address = item.get("address", {})
        start_dt = datetime.fromisoformat(item["start_date"].replace("Z", "+00:00"))
        end_dt = None
        if item.get("end_date"):
            end_dt = datetime.fromisoformat(item["end_date"].replace("Z", "+00:00"))

        # Preço: pega o menor lote disponível
        lots = item.get("lots", []) or []
        prices = [float(l["price"]) for l in lots if l.get("price") is not None]
        price_min = min(prices) if prices else 0.0
        price_max = max(prices) if prices else 0.0

        return RawEvent(
            source="sympla",
            external_id=str(item["id"]),
            name=item.get("name", "").strip(),
            description=_clean_html(item.get("detail", "") or ""),
            venue_name=address.get("name", "") or item.get("name", ""),
            venue_address=f'{address.get("address", "")}, {address.get("complement", "")}'.strip(", "),
            neighborhood=address.get("neighborhood"),
            city=address.get("city", ""),
            date_start=start_dt,
            date_end=end_dt,
            price_min=price_min,
            price_max=price_max,
            currency="BRL",
            capacity=item.get("total_capacity"),
            attendees_confirmed=item.get("total_confirmed", 0),
            url=item.get("url", ""),
            image_url=item.get("image", {}).get("original") if item.get("image") else None,
        )
    except Exception as e:
        log.warning(f"Sympla parse error for item {item.get('id')}: {e}")
        return None


def _clean_html(text: str) -> str:
    """Remove tags HTML básicas da descrição."""
    import re
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()[:1000]  # Claude não precisa de mais que 1000 chars
