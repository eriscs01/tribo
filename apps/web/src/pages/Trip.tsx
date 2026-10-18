import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiProblem } from '../api/client';
import { tripQuery } from '../api/queries';
import { formatDateRange } from '../format';
import { m } from '../messages';
import { ErrorNotice } from '../ui/Notice';
import { AddItemForm } from './AddItem';

export function TripPage({ tripId }: { tripId: string }) {
  const client = useQueryClient();
  const trip = useQuery(tripQuery(client, tripId));
  const notFound = trip.error instanceof ApiProblem && trip.error.code === 'not_found';

  return (
    <section>
      <Link to="/trips">{m.backToTrips}</Link>
      {trip.isPending ? <p aria-live="polite">{m.loading}</p> : null}
      <ErrorNotice
        error={trip.error ?? undefined}
        {...(notFound ? { message: m.trip.notFound } : {})}
      />
      {trip.data ? (
        <>
          <h1>{trip.data.name}</h1>
          <p className="muted">{formatDateRange(trip.data.startDate, trip.data.endDate)}</p>
          <dl className="facts">
            <dt>{m.trip.status}</dt>
            <dd>{m.tripStatus[trip.data.status]}</dd>
            <dt>{m.trip.timezone}</dt>
            <dd>{trip.data.timezone}</dd>
            <dt>{m.trip.currency}</dt>
            <dd>{trip.data.currency}</dd>
          </dl>
          <AddItemForm trip={trip.data} />
        </>
      ) : null}
    </section>
  );
}
