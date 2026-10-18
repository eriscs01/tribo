// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { itemInput, type ItemForm } from './AddItem';
import { safeRedirect } from './SignIn';

const base: ItemForm = {
  type: 'transport',
  title: '  Morning ferry ',
  timing: 'none',
  start: '',
  end: '',
  tz: 'Asia/Manila',
  visibility: 'shared',
};

describe('itemInput', () => {
  it('sends no times when there are none', () => {
    expect(itemInput(base)).toEqual({
      type: 'transport',
      title: 'Morning ferry',
      visibility: 'shared',
    });
  });

  it('sends wall-clock time plus zone for a timed item', () => {
    expect(itemInput({ ...base, timing: 'timed', start: '2026-11-11T07:40' })).toMatchObject({
      start: { local: '2026-11-11T07:40', tz: 'Asia/Manila' },
    });
  });

  it('sends dates for an all-day item, with an end only when given', () => {
    const input = itemInput({ ...base, timing: 'allDay', start: '2026-11-11', end: '2026-11-12' });
    expect(input).toMatchObject({ start: { date: '2026-11-11' }, end: { date: '2026-11-12' } });
    expect(itemInput({ ...base, timing: 'allDay', start: '2026-11-11' })).not.toHaveProperty('end');
  });

  it('ignores an end without a start', () => {
    expect(itemInput({ ...base, timing: 'timed', end: '2026-11-11T09:00' })).not.toHaveProperty(
      'end',
    );
  });
});

describe('safeRedirect', () => {
  it.each([
    ['/trips/trp_x', '/trips/trp_x'],
    [undefined, '/trips'],
    ['https://evil.example/', '/trips'],
    ['//evil.example/', '/trips'],
  ])('%s → %s', (target, expected) => {
    expect(safeRedirect(target)).toBe(expected);
  });
});
