from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class RawEvent(BaseModel):
    """Evento como vem da API externa — sem enriquecimento."""
    source: str                   # "sympla" | "eventbrite"
    external_id: str
    name: str
    description: str
    venue_name: str
    venue_address: str
    neighborhood: Optional[str] = None
    city: str
    date_start: datetime
    date_end: Optional[datetime] = None
    price_min: float = 0.0
    price_max: float = 0.0
    currency: str = "BRL"
    capacity: Optional[int] = None
    attendees_confirmed: Optional[int] = None
    url: str
    image_url: Optional[str] = None


class RerootCategory(str):
    QUIET_SOCIAL = "quiet_social"
    ACTIVE       = "active"
    CREATIVE     = "creative"
    COMMUNITY    = "community"


class EnrichedEvent(BaseModel):
    """Evento após análise pelo Claude — pronto para o frontend."""
    id: str                         # f"{source}_{external_id}"
    source: str
    external_id: str
    name: str
    description: str
    venue_name: str
    venue_address: str
    neighborhood: str
    city: str
    date_start: datetime
    date_end: Optional[datetime]
    price_min: float
    price_max: float
    currency: str
    capacity: Optional[int]
    attendees_confirmed: int = 0

    # ── Campos extraídos pelo Claude ──────────────────────────
    reroot_category: str            # quiet_social | active | creative | community
    category_label: str             # "Encontro Tranquilo"
    category_emoji: str             # "🌿"
    has_food: bool
    is_low_pressure: bool           # bom para re-entrada social
    good_for_reroot: bool
    reroot_reason: str              # "Ambiente íntimo, sem expectativa de performance"
    price_tier: str                 # "free" | "low" | "medium" | "high"
    vibe_summary: str               # frase curta para o card
    expected_size: str              # "small" | "medium" | "large"
    header_gradient: str            # CSS gradient baseado na categoria

    url: str
    image_url: Optional[str]
    fetched_at: datetime
    enriched_at: Optional[datetime] = None
