import { forModule } from '@tribo/db';
import { ApiError, type Tx } from '@tribo/platform';
import { tripWriteRefusal } from './policy.js';
import { lockTripForWrite } from './repo.js';

/** The write path's trip guard: the trip exists, is open to this operation and stays so until commit. */
export async function guardTrip(tx: Tx, tripId: string, operationId: string): Promise<void> {
  const trip = await lockTripForWrite(forModule(tx, 'trips'), tripId);
  const refusal = trip
    ? tripWriteRefusal(
        { archived: trip.archived_at !== null, deleted: trip.deleted_at !== null },
        operationId,
      )
    : 'not_found';
  if (refusal) throw new ApiError(refusal);
}
