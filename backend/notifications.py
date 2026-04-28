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


async def send_scrape_summary(settings, run_started_iso: str) -> None:
    """
    Build and send a per-source summary of the scrape that started at
    `run_started_iso`. Looks up `refresh_log` rows for that window.
    """
    if not settings.smtp_user or not settings.smtp_password:
        return
    rows = db.get_refresh_logs_since(run_started_iso)
    if not rows:
        return

    total_new = sum((r.get("events_new") or 0) for r in rows)
    total_updated = sum((r.get("events_updated") or 0) for r in rows)
    errors = [r for r in rows if (r.get("error") or "").strip()]

    rows_sorted = sorted(
        rows,
        key=lambda r: (-(r.get("events_new") or 0), r.get("source") or ""),
    )

    rows_html = ""
    rows_text = ""
    for r in rows_sorted:
        src = r.get("source") or "?"
        n = r.get("events_new") or 0
        u = r.get("events_updated") or 0
        err = (r.get("error") or "").strip()
        bgcolor = "#FFEBEE" if err else ("#E8F5E9" if n > 0 else "#FAFAFA")
        rows_html += (
            f'<tr><td style="padding:6px 10px;border-bottom:1px solid #EEE;'
            f'background:{bgcolor};font-family:monospace">{src}</td>'
            f'<td style="padding:6px 10px;border-bottom:1px solid #EEE;'
            f'background:{bgcolor};text-align:right">{n}</td>'
            f'<td style="padding:6px 10px;border-bottom:1px solid #EEE;'
            f'background:{bgcolor};text-align:right;color:#888">{u}</td>'
            f'<td style="padding:6px 10px;border-bottom:1px solid #EEE;'
            f'background:{bgcolor};color:#B71C1C;font-size:11px">{err[:80]}</td></tr>'
        )
        rows_text += f"  {src:18s}  new={n:3d}  updated={u:3d}  {err[:60]}\n"

    total_in_db = db.count_events()
    err_summary = f"{len(errors)} fonte(s) com erro" if errors else "nenhum erro"

    subject = f"[auê] scrape {total_new} novos · {total_in_db} no DB"
    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#2C2C2C">
  <h2 style="font-size:18px;margin:0 0 4px">auê · resumo do scrape</h2>
  <p style="font-size:13px;color:#888;margin:0 0 16px">
    {run_started_iso} · {len(rows)} fonte(s) consultada(s) · {err_summary}
  </p>
  <table style="border-collapse:collapse;width:100%;font-size:12px">
    <thead>
      <tr style="background:#2C2C2C;color:white">
        <th style="padding:8px 10px;text-align:left">Fonte</th>
        <th style="padding:8px 10px;text-align:right">Novos</th>
        <th style="padding:8px 10px;text-align:right">Atualizados</th>
        <th style="padding:8px 10px;text-align:left">Erro</th>
      </tr>
    </thead>
    <tbody>{rows_html}</tbody>
    <tfoot>
      <tr style="background:#FAFAFA;font-weight:700">
        <td style="padding:8px 10px">Total</td>
        <td style="padding:8px 10px;text-align:right">{total_new}</td>
        <td style="padding:8px 10px;text-align:right;color:#888">{total_updated}</td>
        <td style="padding:8px 10px;color:#888">{total_in_db} no DB</td>
      </tr>
    </tfoot>
  </table>
  <p style="font-size:11px;color:#999;margin-top:18px">
    auê · enviado automaticamente após cada refresh
  </p>
</div>
"""
    text = (
        f"auê — resumo do scrape\n"
        f"{run_started_iso}  ·  {len(rows)} fontes  ·  {err_summary}\n\n"
        f"{rows_text}\n"
        f"Total novos: {total_new}\n"
        f"Total atualizados: {total_updated}\n"
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
