import type { Schemas } from './api/client';
import { LOCALE } from './messages';

/** A calendar date (YYYY-MM-DD) has no zone: format it as the same day everywhere. */
function day(date: string): Date {
  const [y = 0, mo = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

const DAY = { dateStyle: 'medium', timeZone: 'UTC' } as const;

export function formatDate(date: string, locale = LOCALE): string {
  return new Intl.DateTimeFormat(locale, DAY).format(day(date));
}

export function formatDateRange(start: string, end: string, locale = LOCALE): string {
  return new Intl.DateTimeFormat(locale, DAY).formatRange(day(start), day(end));
}

/** An item time as written on the ground: in its own zone, with the zone named. */
export function formatItemTime(time: Schemas['ItemTime'], locale = LOCALE): string {
  if ('date' in time) return formatDate(time.date, locale);
  return new Intl.DateTimeFormat(locale, {
    // dateStyle cannot be combined with timeZoneName, so the parts are spelled out.
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: time.tz,
    timeZoneName: 'short',
  }).format(new Date(time.at));
}

/** The viewer's own zone, as a default for new trips. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
