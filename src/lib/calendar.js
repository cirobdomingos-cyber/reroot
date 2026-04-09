// Calendar utility — generates ICS files and Google Calendar links
// for Reroot event recommendations.

const PT_MONTHS = {
  Jan: 0, Fev: 1, Mar: 2, Abr: 3, Mai: 4, Jun: 5,
  Jul: 6, Ago: 7, Set: 8, Out: 9, Nov: 10, Dez: 11,
};

/**
 * Parses a Portuguese display date + time into a JS Date.
 * Expects event.date like "Sáb, 12 Abr" and event.time like "15:00".
 * Assumes year 2026.
 */
export function parseEventDate(event) {
  // Strip weekday prefix — everything after the comma
  const datePart = event.date.includes(",")
    ? event.date.split(",")[1].trim()
    : event.date.trim();

  // Expected: "12 Abr"
  const [dayStr, monthStr] = datePart.split(/\s+/);
  const day = parseInt(dayStr, 10);
  const month = PT_MONTHS[monthStr];

  if (month === undefined) {
    throw new Error(`Unknown Portuguese month abbreviation: "${monthStr}"`);
  }

  const [hours, minutes] = event.time.split(":").map(Number);

  return new Date(2026, month, day, hours, minutes, 0);
}

/**
 * Parses a duration string like "2h", "1h30", or "0h45" into minutes.
 */
function parseDurationMinutes(duration) {
  const match = duration.match(/^(\d+)h(\d+)?$/);
  if (!match) {
    throw new Error(`Cannot parse duration: "${duration}"`);
  }
  const hours = parseInt(match[1], 10);
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + mins;
}

/**
 * Formats a Date to ICS datetime string: YYYYMMDDTHHmmSS
 */
function toICSDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Generates a .ics file content string and triggers a browser download.
 */
export function generateICS(event) {
  const start = parseEventDate(event);
  const durationMs = parseDurationMinutes(event.duration) * 60 * 1000;
  const end = new Date(start.getTime() + durationMs);

  const description = `${event.description}\\n\\nPor que o Reroot recomenda: ${event.rerootReason}`;

  // CRLF line endings per RFC 5545
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Reroot//Event Export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@reroot.app`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(start)}`,
    `DTEND:${toICSDate(end)}`,
    `SUMMARY:${event.name}`,
    `LOCATION:${event.venue}`,
    `DESCRIPTION:${description}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const content = lines.join("\r\n");

  // Trigger browser download
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `reroot-${event.id}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);

  return content;
}

/**
 * Returns a Google Calendar "add event" URL.
 */
export function getGoogleCalendarURL(event) {
  const start = parseEventDate(event);
  const durationMs = parseDurationMinutes(event.duration) * 60 * 1000;
  const end = new Date(start.getTime() + durationMs);

  const details = `${event.description}\n\nPor que o Reroot recomenda: ${event.rerootReason}`;

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.name,
    dates: `${toICSDate(start)}/${toICSDate(end)}`,
    location: event.venue,
    details,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
