import { describe, expect, it } from 'vitest';
import { overlapWarnings, timelineDays, type TimelineItem } from './timeline.js';

const at = (local: string, tz: string, offset: string) => ({
  local,
  tz,
  at: new Date(`${local}:00${offset}`),
});
const manila = (local: string) => at(local, 'Asia/Manila', '+08:00');

function item(id: string, init: Partial<TimelineItem>): TimelineItem {
  return { id, type: 'activity', status: 'planned', start: null, end: null, ...init };
}

describe('timelineDays', () => {
  it('puts a one-day item whole on its local day, at its local time in its own zone', () => {
    const flight = item('a', {
      type: 'transport',
      start: manila('2026-11-11T06:10'),
      end: manila('2026-11-11T07:25'),
    });
    expect(timelineDays([flight], {})).toEqual([
      {
        date: '2026-11-11',
        entries: [{ itemId: 'a', part: 'whole', time: '06:10', tz: 'Asia/Manila' }],
      },
    ]);
  });

  it('shows a longer item as its start and its end, each on its own local day and zone', () => {
    // Leaves Manila on the 13th, lands in Tokyo on the 14th, local time there.
    const overnight = item('a', {
      type: 'transport',
      start: manila('2026-11-13T23:30'),
      end: at('2026-11-14T04:45', 'Asia/Tokyo', '+09:00'),
    });
    expect(timelineDays([overnight], {})).toEqual([
      {
        date: '2026-11-13',
        entries: [{ itemId: 'a', part: 'start', time: '23:30', tz: 'Asia/Manila' }],
      },
      {
        date: '2026-11-14',
        entries: [{ itemId: 'a', part: 'end', time: '04:45', tz: 'Asia/Tokyo' }],
      },
    ]);
  });

  it('shows a stay as its check-in, a staying line for each night between, and its check-out', () => {
    const stay = item('s', {
      type: 'lodging',
      start: { date: '2026-11-11' },
      end: { date: '2026-11-14' },
    });
    const line = (part: string) => ({ itemId: 's', part, time: null, tz: null });
    expect(timelineDays([stay], {})).toEqual([
      { date: '2026-11-11', entries: [line('check_in')] },
      { date: '2026-11-12', entries: [line('staying')] },
      { date: '2026-11-13', entries: [line('staying')] },
      { date: '2026-11-14', entries: [line('check_out')] },
    ]);
  });

  it('shows a stay that checks in and out on one day as its check-in, then its check-out', () => {
    const dayUse = item('s', {
      type: 'lodging',
      start: { date: '2026-11-12' },
      end: { date: '2026-11-12' },
    });
    expect(timelineDays([dayUse], {})[0]?.entries.map((e) => e.part)).toEqual([
      'check_in',
      'check_out',
    ]);
  });

  it('keeps only the days of the range, so a stay shows its nights inside it', () => {
    const stay = item('s', {
      type: 'lodging',
      start: { date: '2026-11-11' },
      end: { date: '2026-11-14' },
    });
    const days = timelineDays([stay], { from: '2026-11-12', to: '2026-11-12' });
    expect(days).toEqual([
      { date: '2026-11-12', entries: [{ itemId: 's', part: 'staying', time: null, tz: null }] },
    ]);
  });

  it('leaves undated items out, and orders a day all-day first, then by time, then by id', () => {
    const items = [
      item('c', { start: manila('2026-11-12T09:00') }),
      item('b', { start: manila('2026-11-12T09:00') }),
      item('a', { start: manila('2026-11-12T08:00') }),
      item('d', { start: { date: '2026-11-12' } }),
      item('e', { type: 'task' }),
    ];
    const [day] = timelineDays(items, {});
    expect(day?.entries.map((e) => e.itemId)).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('overlapWarnings', () => {
  const ferry = item('f', {
    type: 'transport',
    start: manila('2026-11-11T09:00'),
    end: manila('2026-11-11T11:00'),
  });
  const dive = item('d', {
    start: manila('2026-11-11T10:30'),
    end: manila('2026-11-11T12:00'),
  });

  it('warns once for two timed items that overlap and share someone on their boards', () => {
    const boards = new Map([
      ['f', ['m1', 'm2']],
      ['d', ['m2']],
    ]);
    expect(overlapWarnings([ferry, dive], boards)).toEqual([
      { code: 'overlap', itemId: 'd', withItemId: 'f' },
    ]);
  });

  it('stays quiet when nobody is on both, when they only touch, or when one is cancelled', () => {
    const apart = new Map([
      ['f', ['m1']],
      ['d', ['m2']],
    ]);
    expect(overlapWarnings([ferry, dive], apart)).toEqual([]);
    const both = new Map([
      ['f', ['m1']],
      ['d', ['m1']],
      ['l', ['m1']],
    ]);
    const lunch = item('l', {
      type: 'meal',
      start: manila('2026-11-11T12:00'),
      end: manila('2026-11-11T13:00'),
    });
    expect(overlapWarnings([dive, lunch], both)).toEqual([]);
    expect(overlapWarnings([ferry, { ...dive, status: 'cancelled' }], both)).toEqual([]);
    const instant = { ...dive, end: dive.start };
    expect(overlapWarnings([ferry, instant], both)).toEqual([]);
  });

  it('leaves stays, rentals, tasks and all-day items to their own checks', () => {
    const boards = new Map([
      ['f', ['m1']],
      ['s', ['m1']],
      ['r', ['m1']],
      ['x', ['m1']],
    ]);
    const stay = item('s', {
      type: 'lodging',
      start: manila('2026-11-11T08:00'),
      end: manila('2026-11-12T08:00'),
    });
    const rental = item('r', {
      type: 'ground',
      start: manila('2026-11-11T08:00'),
      end: manila('2026-11-11T18:00'),
    });
    const day = item('x', { start: { date: '2026-11-11' }, end: { date: '2026-11-11' } });
    expect(overlapWarnings([ferry, stay, rental, day], boards)).toEqual([]);
  });
});
