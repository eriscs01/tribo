import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type SubmitEvent } from 'react';
import { api, unwrap, type Schemas } from '../api/client';
import { keys, type Trip } from '../api/queries';
import { m, optionsOf } from '../messages';
import { Field } from '../ui/Field';
import { ErrorNotice } from '../ui/Notice';
import { fieldErrorsOf } from '../ui/problem';
import { TimeZoneInput } from '../ui/TimeZoneInput';

type Timing = 'none' | 'timed' | 'allDay';
type Visibility = Exclude<Schemas['ItemVisibility'], 'selected'>;

export interface ItemForm {
  type: Schemas['ItemType'];
  title: string;
  timing: Timing;
  /** `YYYY-MM-DDTHH:MM` when timed, `YYYY-MM-DD` when all day; empty end means none. */
  start: string;
  end: string;
  tz: string;
  visibility: Visibility;
}

/** The items.create body for a form: wall-clock plus zone, or all-day dates, never mixed. */
export function itemInput(form: ItemForm): Schemas['ItemInput'] {
  const time = (value: string): Schemas['TimeInput'] =>
    form.timing === 'timed' ? { local: value, tz: form.tz } : { date: value };
  const timed = form.timing !== 'none' && form.start !== '';
  return {
    type: form.type,
    title: form.title.trim(),
    visibility: form.visibility,
    ...(timed ? { start: time(form.start) } : {}),
    ...(timed && form.end !== '' ? { end: time(form.end) } : {}),
  };
}

const TYPES = optionsOf(m.itemType);
/** `selected` needs membership ids, which the members screen brings. */
const VISIBILITIES: Visibility[] = ['shared', 'private'];
const TIMINGS: [Timing, string][] = [
  ['none', m.addItem.timingNone],
  ['timed', m.addItem.timingTimed],
  ['allDay', m.addItem.timingAllDay],
];

export function AddItemForm({ trip }: { trip: Trip }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const timingId = useId();
  const [form, setForm] = useState<ItemForm>({
    type: 'activity',
    title: '',
    timing: 'none',
    start: '',
    end: '',
    tz: trip.timezone,
    visibility: 'shared',
  });
  const set = <K extends keyof ItemForm>(field: K, value: ItemForm[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
  };

  const add = useMutation({
    mutationFn: (body: Schemas['ItemInput']) =>
      unwrap(api.POST('/v1/trips/{tripId}/items', { params: { path: { tripId: trip.id } }, body })),
    onSuccess: async (item) => {
      client.setQueryData(keys.item(item.id), item);
      await navigate({ to: '/items/$itemId', params: { itemId: item.id } });
    },
  });

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    add.mutate(itemInput(form));
  };

  const fields = fieldErrorsOf(add.error);
  const inputType = form.timing === 'timed' ? 'datetime-local' : 'date';

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby="add-item">
      <h2 id="add-item">{m.addItem.title}</h2>
      <ErrorNotice error={add.error ?? undefined} />
      <div className="row">
        <Field label={m.addItem.type} error={fields.type}>
          {(control) => (
            <select
              {...control}
              name="type"
              value={form.type}
              onChange={(e) => {
                set('type', e.target.value as ItemForm['type']);
              }}
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {m.itemType[type]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={m.addItem.itemTitle} error={fields.title}>
          {(control) => (
            <input
              {...control}
              name="title"
              required
              maxLength={300}
              value={form.title}
              onChange={(e) => {
                set('title', e.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <fieldset>
        <legend>{m.addItem.timing}</legend>
        <div className="choices">
          {TIMINGS.map(([timing, label]) => (
            <label key={timing} className="choice" htmlFor={`${timingId}-${timing}`}>
              <input
                id={`${timingId}-${timing}`}
                type="radio"
                name="timing"
                value={timing}
                checked={form.timing === timing}
                onChange={() => {
                  setForm((f) => ({ ...f, timing, start: '', end: '' }));
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {form.timing === 'none' ? null : (
        <div className="row">
          <Field label={m.addItem.start} error={fields.start}>
            {(control) => (
              <input
                {...control}
                name="start"
                type={inputType}
                required
                value={form.start}
                onChange={(e) => {
                  set('start', e.target.value);
                }}
              />
            )}
          </Field>
          <Field label={m.addItem.end} error={fields.end} optional>
            {(control) => (
              <input
                {...control}
                name="end"
                type={inputType}
                min={form.start || undefined}
                value={form.end}
                onChange={(e) => {
                  set('end', e.target.value);
                }}
              />
            )}
          </Field>
          {form.timing === 'timed' ? (
            <Field label={m.addItem.timezone}>
              {(control) => (
                <TimeZoneInput
                  {...control}
                  name="tz"
                  required
                  value={form.tz}
                  onChange={(zone) => {
                    set('tz', zone);
                  }}
                />
              )}
            </Field>
          ) : null}
        </div>
      )}
      <Field label={m.addItem.visibility} error={fields.visibility}>
        {(control) => (
          <select
            {...control}
            name="visibility"
            value={form.visibility}
            onChange={(e) => {
              set('visibility', e.target.value as Visibility);
            }}
          >
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {m.itemVisibility[v]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <button type="submit" disabled={add.isPending}>
        {add.isPending ? m.addItem.submitting : m.addItem.submit}
      </button>
    </form>
  );
}
