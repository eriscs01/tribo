import { describe, expect, it } from 'vitest';
import { formatDate, formatDateRange, formatItemTime } from './format.js';

describe('formatting', () => {
  it('shows a calendar date as the same day in any zone', () => {
    expect(formatDate('2026-11-11')).toBe('Nov 11, 2026');
    expect(formatDateRange('2026-11-11', '2026-11-14')).toMatch(/^Nov 11\s–\s14, 2026$/);
  });

  it('shows a timed item in its own zone', () => {
    const ferry = { local: '2026-11-11T07:40', tz: 'Asia/Manila', at: '2026-11-10T23:40:00.000Z' };
    expect(formatItemTime(ferry)).toMatch(/^Nov 11, 2026, 7:40\sAM GMT\+8$/);
    expect(formatItemTime({ date: '2026-11-12' })).toBe('Nov 12, 2026');
  });
});
