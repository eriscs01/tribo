import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiProblem } from '../api/client.js';
import { itemQuery, tripQuery } from '../api/queries.js';
import { formatItemTime } from '../format.js';
import { m } from '../messages.js';
import { ErrorNotice } from '../ui/Notice.js';

export function ItemPage({ itemId }: { itemId: string }) {
  const client = useQueryClient();
  const item = useQuery(itemQuery(itemId));
  const trip = useQuery({
    ...tripQuery(client, item.data?.tripId ?? ''),
    enabled: item.data !== undefined,
  });
  const notFound = item.error instanceof ApiProblem && item.error.code === 'not_found';

  return (
    <section>
      {item.data ? (
        <Link to="/trips/$tripId" params={{ tripId: item.data.tripId }}>
          {trip.data ? m.backToTrip(trip.data.name) : m.backToTrips}
        </Link>
      ) : (
        <Link to="/trips">{m.backToTrips}</Link>
      )}
      {item.isPending ? <p aria-live="polite">{m.loading}</p> : null}
      <ErrorNotice
        error={item.error ?? undefined}
        {...(notFound ? { message: m.item.notFound } : {})}
      />
      {item.data ? (
        <>
          <h1>{item.data.title}</h1>
          <dl className="facts">
            <dt>{m.item.type}</dt>
            <dd>{m.itemType[item.data.type]}</dd>
            <dt>{m.item.status}</dt>
            <dd>{m.itemStatus[item.data.status]}</dd>
            <dt>{m.item.start}</dt>
            <dd>{item.data.start ? formatItemTime(item.data.start) : m.item.noTime}</dd>
            <dt>{m.item.end}</dt>
            <dd>{item.data.end ? formatItemTime(item.data.end) : m.item.noTime}</dd>
            <dt>{m.item.visibility}</dt>
            <dd>{m.itemVisibility[item.data.visibility]}</dd>
          </dl>
        </>
      ) : null}
    </section>
  );
}
