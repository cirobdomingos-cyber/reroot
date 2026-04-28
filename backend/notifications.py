"""
Email notifications — Resend (HTTPS) preferred, SMTP fallback.

Used to notify the founder after each scrape completes with a summary of
new events found per source. Best-effort — silent on failure so the
scrape pipeline never fails because the email transport blipped.

Why two transports:
  - Many cloud hosts (Railway, Fly.io, Render) block outbound SMTP ports
    25/465/587 to prevent spam abuse. SMTP fails with "Network is
    unreachable" on those.
  - Resend uses HTTPS so it works on every cloud.

Setup (preferred — Resend):
  1. Sign up at resend.com (free 3,000/month)
  2. Dashboard → API Keys → create one
  3. Set env var: RESEND_API_KEY = re_xxx...
  4. Without a verified domain, you can only send to the email used to
     sign up. Add a domain later (DNS ~5min) for sending to other users.

Setup (fallback — Gmail SMTP, only works on hosts allowing port 587):
  1. Enable 2FA on the Google account
  2. Visit myaccount.google.com/apppasswords → generate a 16-char App Password
  3. Set env vars:
       SMTP_USER = your.email@gmail.com
       SMTP_PASSWORD = the 16-char App Password (NOT your regular password)
"""
import asyncio
import json
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Optional

import database as db

log = logging.getLogger(__name__)


def _send_smtp_sync(host: str, port: int, user: str, password: str,
                    from_addr: str, to: str,
                    subject: str, html: str, text: Optional[str] = None) -> bool:
    """Synchronous SMTP send. Called from a thread via asyncio.to_thread."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to
    if text:
        msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    # Gmail App Passwords are displayed with spaces every 4 chars
    # ("umgp jmbc ywkn mgrd"). The actual password is the 16 chars
    # WITHOUT spaces — strip defensively so either format in env vars
    # works. Also strips accidental trailing whitespace.
    password = (password or "").replace(" ", "").strip()
    try:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(user, [to], msg.as_string())
        return True
    except Exception as e:
        log.warning(f"SMTP send failed: {e}")
        return False


def _send_resend_sync(api_key: str, from_addr: str, to: str,
                      subject: str, html: str, text: Optional[str] = None) -> bool:
    """Send via Resend HTTPS API. Synchronous — call from a thread.
    Returns True on 2xx, False on auth/quota/other error."""
    try:
        import resend
        resend.api_key = api_key
        params = {
            "from": from_addr,
            "to": [to],
            "subject": subject,
            "html": html,
        }
        if text:
            params["text"] = text
        resend.Emails.send(params)
        return True
    except Exception as e:
        log.warning(f"Resend send failed: {type(e).__name__}: {e}")
        return False


async def send_email(settings, to: str, subject: str,
                     html: str, text: Optional[str] = None) -> bool:
    """Returns True on success, False otherwise. Never raises.
    Routes via Resend when RESEND_API_KEY is set (cloud-friendly),
    else falls back to SMTP. SMTP fails on hosts that block outbound
    port 587 (e.g. Railway) — Resend works everywhere."""
    # Prefer Resend when configured — works through HTTPS, no port issues.
    if getattr(settings, "resend_api_key", "").strip():
        from_addr = settings.resend_from or "auê <onboarding@resend.dev>"
        return await asyncio.to_thread(
            _send_resend_sync,
            api_key=settings.resend_api_key.strip(),
            from_addr=from_addr,
            to=to,
            subject=subject,
            html=html,
            text=text,
        )
    # Fallback: SMTP (works on hosts that allow port 587)
    if not settings.smtp_user or not settings.smtp_password:
        log.info("Neither RESEND_API_KEY nor SMTP credentials set — skipping email send")
        return False
    from_addr = settings.smtp_from or formataddr(("auê", settings.smtp_user))
    return await asyncio.to_thread(
        _send_smtp_sync,
        host=settings.smtp_host,
        port=settings.smtp_port,
        user=settings.smtp_user,
        password=settings.smtp_password,
        from_addr=from_addr,
        to=to,
        subject=subject,
        html=html,
        text=text,
    )


def _ig_handle(external_id: str) -> str:
    """Pull the handle out of `ig_<handle>_<post>`. Empty string when the
    id doesn't fit (aue_originals, AI-generated events)."""
    if not external_id or not external_id.startswith("ig_"):
        return ""
    rest = external_id[3:]
    idx = rest.rfind("_")
    return rest[:idx] if idx > 0 else ""


def _format_event_short(payload: dict) -> tuple[str, str]:
    """Return (name, when_label) for the email row."""
    name = (payload.get("name") or "?").strip()
    ds = (payload.get("date_start") or "")[:16]  # YYYY-MM-DDTHH:MM
    when = ds.replace("T", " · ") if ds else "—"
    venue = (payload.get("venue_name") or "").strip()
    if venue:
        return name, f"{venue} · {when}"
    return name, when


async def send_scrape_summary(settings, run_started_iso: str, new_event_ids: list[str] | None = None) -> None:
    """
    Build and send a summary of the scrape that started at `run_started_iso`.

    Post-Apr 2026 the catalog is IG-only — there's no longer a per-source
    table to render (Sympla/Eventbrite/etc. are gone). Instead we group
    the newly-added events by IG handle and list them inline with
    venue + date, so the founder can scan "what showed up today, from whom".

    Handles with zero hits are hidden — keeps the email tight on slow days.
    """
    if not settings.smtp_user or not settings.smtp_password:
        return
    rows = db.get_refresh_logs_since(run_started_iso)
    if not rows:
        return

    errors = [r for r in rows if (r.get("error") or "").strip()]
    total_in_db = db.count_events()
    new_events = db.get_events_by_ids(list(new_event_ids or []))

    # Group new events by IG handle (or by source for non-IG events).
    by_handle: dict[str, list[dict]] = {}
    for ev in new_events:
        try:
            payload = json.loads(ev["payload"])
        except (json.JSONDecodeError, TypeError):
            continue
        handle = _ig_handle(ev.get("external_id") or "")
        if not handle:
            handle = ev.get("source") or "outro"
        by_handle.setdefault(handle, []).append(payload)

    # Sort handles by hit count DESC, then alphabetic. Curators can scan
    # the email top-down and see the most active handles first.
    sorted_handles = sorted(
        by_handle.items(),
        key=lambda kv: (-len(kv[1]), kv[0].lower()),
    )

    total_new = len(new_events)
    err_summary = f"{len(errors)} erro(s)" if errors else "sem erros"
    subject = f"[auê] scrape {total_new} novos · {total_in_db} no DB"

    # Build the per-handle blocks. Each block is one IG handle + an inline
    # list of its new events (name + venue/date). No table — handle blocks
    # read better as cards on mobile email clients.
    blocks_html = ""
    blocks_text = ""
    for handle, evs in sorted_handles:
        is_ig = handle and handle != "outro" and handle in {h["handle"] for h in db.get_enabled_ig_accounts()}
        title = f"@{handle}" if is_ig else handle
        ig_link = f'<a href="https://www.instagram.com/{handle}/" style="color:#E8623F;text-decoration:none">{title}</a>' if is_ig else title
        items_html = ""
        for payload in evs:
            name, when = _format_event_short(payload)
            items_html += (
                f'<li style="padding:4px 0;font-size:13px;color:#2C2C2C">'
                f'<strong>{name}</strong><br>'
                f'<span style="color:#888;font-size:12px">{when}</span></li>'
            )
            blocks_text += f"    · {name}  ({when})\n"
        blocks_html += f"""
  <div style="margin-bottom:16px;padding:12px 14px;background:#FAFAFA;border-left:3px solid #E8623F;border-radius:6px">
    <div style="font-size:14px;font-weight:700;margin-bottom:6px">
      {ig_link} <span style="color:#888;font-weight:400">· {len(evs)} novo{'s' if len(evs) != 1 else ''}</span>
    </div>
    <ul style="margin:0;padding-left:18px">{items_html}</ul>
  </div>"""
        blocks_text = f"  {title}  ({len(evs)} novos)\n" + blocks_text

    if not sorted_handles:
        blocks_html = '<p style="color:#888;font-size:13px">Nenhum evento novo nessa rodada.</p>'
        blocks_text = "  (nenhum evento novo)\n"

    err_html = ""
    if errors:
        err_lines = "".join(
            f'<li style="font-size:12px;color:#B71C1C">{(r.get("source") or "?")}: {(r.get("error") or "")[:120]}</li>'
            for r in errors
        )
        err_html = f"""
  <div style="margin-top:14px;padding:10px 14px;background:#FFEBEE;border-radius:6px">
    <strong style="font-size:13px;color:#B71C1C">Erros:</strong>
    <ul style="margin:6px 0 0;padding-left:18px">{err_lines}</ul>
  </div>"""

    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#2C2C2C">
  <h2 style="font-size:18px;margin:0 0 4px">auê · resumo do scrape</h2>
  <p style="font-size:13px;color:#888;margin:0 0 16px">
    {run_started_iso} · {total_new} novo{'s' if total_new != 1 else ''} de {len(sorted_handles)} fonte{'s' if len(sorted_handles) != 1 else ''} · {err_summary}
  </p>
  {blocks_html}
  {err_html}
  <p style="font-size:11px;color:#999;margin-top:18px">
    auê · enviado automaticamente após cada refresh · catálogo agora: {total_in_db} eventos
  </p>
</div>
"""
    text = (
        f"auê — resumo do scrape\n"
        f"{run_started_iso}  ·  {total_new} novos  ·  {err_summary}\n\n"
        f"{blocks_text}\n"
        f"Catálogo agora: {total_in_db} eventos\n"
    )
    ok = await send_email(
        settings=settings,
        to=settings.founder_email,
        subject=subject,
        html=html,
        text=text,
    )
    if ok:
        log.info(f"Scrape summary email sent ({total_new} new) → {settings.founder_email}")
