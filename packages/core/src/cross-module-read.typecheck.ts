// Typecheck fixture for the boundary rule: never imported, only compiled. Every line
// marked expect-error below must stay a type error; if a cross-module read starts to
// compile, the unused directive itself fails `pnpm typecheck`.
/* eslint-disable no-void -- `void` marks each expression as compiled only, never used */
import type { ItemsDb } from './items/repo.js';
import type { ItineraryDb } from './itinerary/repo.js';
import type { TripsDb } from './trips/repo.js';

export function ownTablesCompile(items: ItemsDb, trips: TripsDb) {
  return [
    items.selectFrom('tribo.items').select('id'),
    items.selectFrom('tribo.allocations').select('membership_id'),
    trips.selectFrom('tribo.memberships').select('trip_id'),
  ];
}

export function crossModuleReadsFail(items: ItemsDb, trips: TripsDb, itinerary: ItineraryDb): void {
  // @ts-expect-error items cannot read trips' memberships
  void items.selectFrom('tribo.memberships').select('id');
  // @ts-expect-error trips cannot read items
  void trips.selectFrom('tribo.items').select('id');
  // @ts-expect-error items cannot write the audit log
  void items.insertInto('audit.audit_events');
  void items
    .selectFrom('tribo.items')
    // @ts-expect-error a join is a read too
    .innerJoin('tribo.trips', 'tribo.trips.id', 'tribo.items.trip_id');
  // @ts-expect-error itinerary owns no table; it reads items through their service
  void itinerary.selectFrom('tribo.items').select('id');
}
