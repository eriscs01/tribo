import * as z from 'zod';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * IANA time zone name, e.g. Asia/Manila. Area/Location names and UTC only, as the
 * tribo.iana_tz domain stores them (R17): abbreviations and POSIX specs are refused.
 */
export const TimeZone = z
  .string()
  .regex(/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/, 'expected an IANA Area/Location name')
  .refine(isTimeZone, 'expected an IANA time zone')
  .meta({ id: 'TimeZone' });

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A time as written on the ground: wall-clock minutes plus zone. Writes take this, never
 * an offset; the server resolves the UTC instant and returns it read-only.
 */
export const WallClockTime = z
  .strictObject({
    local: z
      .string()
      .regex(LOCAL, 'expected YYYY-MM-DDTHH:mm')
      .refine((s) => {
        const [, y, m, d] = LOCAL.exec(s) ?? [];
        return isRealDate(Number(y), Number(m), Number(d));
      }, 'not a calendar date'),
    tz: TimeZone,
  })
  .meta({ id: 'WallClockTime' });

/** An all-day value: a calendar date with no time. */
export const AllDay = z.strictObject({ date: z.iso.date() }).meta({ id: 'AllDay' });

/** A time input is either wall-clock time plus zone or an all-day date, never both. */
export const TimeInput = z.union([WallClockTime, AllDay]).meta({ id: 'TimeInput' });

/** A resolved UTC instant, returned read-only. */
export const Instant = z.iso.datetime().meta({ id: 'Instant' });

export type WallClockTime = z.infer<typeof WallClockTime>;
export type AllDay = z.infer<typeof AllDay>;
export type TimeInput = z.infer<typeof TimeInput>;
