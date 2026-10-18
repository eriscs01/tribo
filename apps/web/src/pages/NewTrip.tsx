import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type SubmitEvent } from 'react';
import { api, ApiProblem, unwrap, type Schemas } from '../api/client';
import { keys } from '../api/queries';
import { localTimeZone } from '../format';
import { m } from '../messages';
import { Field } from '../ui/Field';
import { ErrorNotice } from '../ui/Notice';
import { fieldErrorsOf } from '../ui/problem';
import { TimeZoneInput } from '../ui/TimeZoneInput';

export function NewTripPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<Schemas['TripInput']>({
    name: '',
    startDate: '',
    endDate: '',
    currency: 'PHP',
    timezone: localTimeZone(),
  });
  const set = (field: keyof Schemas['TripInput']) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
  };

  const create = useMutation({
    mutationFn: (body: Schemas['TripInput']) => unwrap(api.POST('/v1/trips', { body })),
    onSuccess: async (trip) => {
      client.setQueryData(keys.trip(trip.id), trip);
      await client.invalidateQueries({ queryKey: keys.trips });
      await navigate({ to: '/trips/$tripId', params: { tripId: trip.id } });
    },
  });

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    create.mutate({
      ...form,
      name: form.name.trim(),
      currency: form.currency.trim().toUpperCase(),
    });
  };

  const fields = fieldErrorsOf(create.error);
  const needMfa = create.error instanceof ApiProblem && create.error.code === 'mfa_required';

  return (
    <section className="narrow">
      <Link to="/trips">{m.backToTrips}</Link>
      <h1>{m.newTrip.title}</h1>
      <form onSubmit={onSubmit} noValidate>
        <ErrorNotice
          error={create.error ?? undefined}
          {...(needMfa ? { message: m.newTrip.needMfa } : {})}
        />
        <Field label={m.newTrip.name} error={fields.name}>
          {(control) => (
            <input
              {...control}
              name="name"
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => {
                set('name')(e.target.value);
              }}
            />
          )}
        </Field>
        <div className="row">
          <Field label={m.newTrip.startDate} error={fields.startDate}>
            {(control) => (
              <input
                {...control}
                name="startDate"
                type="date"
                required
                value={form.startDate}
                onChange={(e) => {
                  set('startDate')(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label={m.newTrip.endDate} error={fields.endDate}>
            {(control) => (
              <input
                {...control}
                name="endDate"
                type="date"
                required
                min={form.startDate || undefined}
                value={form.endDate}
                onChange={(e) => {
                  set('endDate')(e.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Field label={m.newTrip.currency} hint={m.newTrip.currencyHint} error={fields.currency}>
          {(control) => (
            <input
              {...control}
              name="currency"
              required
              maxLength={3}
              autoCapitalize="characters"
              spellCheck={false}
              value={form.currency}
              onChange={(e) => {
                set('currency')(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={m.newTrip.timezone} hint={m.newTrip.timezoneHint} error={fields.timezone}>
          {(control) => (
            <TimeZoneInput
              {...control}
              name="timezone"
              required
              value={form.timezone}
              onChange={set('timezone')}
            />
          )}
        </Field>
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? m.newTrip.submitting : m.newTrip.submit}
        </button>
      </form>
    </section>
  );
}
