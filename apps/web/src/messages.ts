// Every user-facing string, in one plain map (technical design, "Localisation"). An ICU
// library comes in only with a second locale.
import type { ErrorCode, Schemas } from './api/client.js';

export const LOCALE = 'en';

export const m = {
  appName: 'Tribo',
  skipToContent: 'Skip to content',
  signOut: 'Sign out',
  signedInAs: (username: string) => `Signed in as ${username}`,
  loading: 'Loading…',
  backToTrips: 'All trips',
  backToTrip: (name: string) => `Back to ${name}`,
  optional: '(optional)',

  signIn: {
    title: 'Sign in',
    username: 'Username',
    password: 'Password',
    code: 'Authentication code',
    codeHint: 'Six digits from your authenticator app.',
    recoveryCode: 'Recovery code',
    recoveryHint: 'One of the recovery codes you saved when you set up the app. Each works once.',
    useRecovery: 'Use a recovery code instead',
    useCode: 'Use an authentication code instead',
    submit: 'Sign in',
    submitting: 'Signing in…',
    needCode: 'This account needs a second factor: enter the code from your authenticator app.',
    wrong: 'That username, password or code is not right.',
  },

  trips: {
    title: 'My trips',
    empty: 'No trips yet. Create one, or open an invite link from a trip owner.',
    create: 'New trip',
    more: 'Show more trips',
    dates: (range: string, zone: string) => `${range} · ${zone}`,
  },

  newTrip: {
    title: 'New trip',
    name: 'Trip name',
    startDate: 'First day',
    endDate: 'Last day',
    currency: 'Currency',
    currencyHint: 'Three-letter code, such as PHP.',
    timezone: 'Time zone',
    timezoneHint: 'Where the trip happens, such as Asia/Manila.',
    submit: 'Create trip',
    submitting: 'Creating…',
    needMfa: 'Trip owners need two-factor sign-in. Sign out and sign in again with your code.',
  },

  trip: {
    notFound: 'This trip does not exist or you are not a member of it.',
    currency: 'Currency',
    timezone: 'Time zone',
    status: 'Status',
  },

  addItem: {
    title: 'Add an item',
    type: 'Type',
    itemTitle: 'Title',
    timing: 'When',
    timingNone: 'No time yet',
    timingTimed: 'At a time',
    timingAllDay: 'All day',
    start: 'Starts',
    end: 'Ends',
    timezone: 'Time zone',
    visibility: 'Who can see it',
    submit: 'Add item',
    submitting: 'Adding…',
  },

  item: {
    notFound: 'This item does not exist or you cannot see it.',
    type: 'Type',
    status: 'Status',
    start: 'Starts',
    end: 'Ends',
    visibility: 'Visible to',
    noTime: 'Not set',
  },

  tripStatus: {
    draft: 'Draft',
    planning: 'Planning',
    active: 'Active',
    completed: 'Completed',
    archived: 'Archived',
  } satisfies Record<Schemas['TripStatus'], string>,

  itemType: {
    transport: 'Transport',
    lodging: 'Lodging',
    ground: 'Ground transport',
    activity: 'Activity',
    meal: 'Meal',
    task: 'Task',
    note: 'Note',
    document: 'Document',
  } satisfies Record<Schemas['ItemType'], string>,

  itemStatus: {
    draft: 'Draft',
    planned: 'Planned',
    booked: 'Booked',
    confirmed: 'Confirmed',
    open: 'Open',
    done: 'Done',
    cancelled: 'Cancelled',
  } satisfies Record<Schemas['ItemStatus'], string>,

  /** `selected` needs member ids, which arrive with the members screen. */
  itemVisibility: {
    shared: 'Everyone on the trip',
    private: 'Only me',
    selected: 'Selected members',
  } satisfies Record<Schemas['ItemVisibility'], string>,

  /** Fallback text per error code; forms show field errors next to their fields. */
  errors: {
    byCode: {
      unauthenticated: 'Your session has ended. Sign in again.',
      forbidden: 'You are not allowed to do that.',
      not_found: 'That does not exist, or you cannot see it.',
      validation_failed: 'Some fields need attention.',
      rate_limited: 'Too many attempts. Wait a minute and try again.',
      trip_archived: 'This trip is archived and read-only.',
    } satisfies Partial<Record<ErrorCode, string>> as Partial<Record<ErrorCode, string>>,
    network: 'Tribo cannot be reached. Check your connection and try again.',
    other: (requestId: string) =>
      requestId === ''
        ? 'Something went wrong. Try again.'
        : `Something went wrong. Try again, or quote reference ${requestId}.`,
  },
};

/** The keys of a label map, typed as its enum: the runtime list of values. */
export function optionsOf<K extends string>(labels: Record<K, string>): K[] {
  return Object.keys(labels) as K[];
}
