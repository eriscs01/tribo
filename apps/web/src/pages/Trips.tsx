import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { tripsQuery } from '../api/queries';
import { formatDateRange } from '../format';
import { m } from '../messages';
import { ErrorNotice } from '../ui/Notice';

export function TripsPage() {
  const trips = useInfiniteQuery(tripsQuery);
  const items = trips.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>{m.trips.title}</h1>
        <Link to="/trips/new" className="button">
          {m.trips.create}
        </Link>
      </div>
      {trips.isPending ? <p aria-live="polite">{m.loading}</p> : null}
      <ErrorNotice error={trips.error ?? undefined} />
      {trips.isSuccess && items.length === 0 ? <p>{m.trips.empty}</p> : null}
      {items.length > 0 ? (
        <ul className="cards">
          {items.map((trip) => (
            <li key={trip.id} className="card">
              <Link to="/trips/$tripId" params={{ tripId: trip.id }} className="card-title">
                {trip.name}
              </Link>
              <p className="muted">
                {m.trips.dates(formatDateRange(trip.startDate, trip.endDate), trip.timezone)}
              </p>
              <p className="badge">{m.tripStatus[trip.status]}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {trips.hasNextPage ? (
        <button
          type="button"
          className="button-secondary"
          disabled={trips.isFetchingNextPage}
          onClick={() => {
            // Failures land in the query's error state, shown above.
            trips.fetchNextPage().catch(() => undefined);
          }}
        >
          {trips.isFetchingNextPage ? m.loading : m.trips.more}
        </button>
      ) : null}
    </section>
  );
}
