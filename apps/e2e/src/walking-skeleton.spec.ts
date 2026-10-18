// Sprint 0 exit criteria 1–2 against a running stack, through its browser UI and its CLI:
// the first admin is created on the host, enrols TOTP and signs in with it; they create a
// trip, add an item and read it back; the item's create event is in the trip's audit chain
// and `tribo audit verify` reports the chain intact. People and trips are invented.
import { expect, test } from '@playwright/test';
import { decodeTypeId, ID_PREFIX } from '@tribo/contract';
import { totpFor } from '@tribo/testkit/totp';
import { auditVerify, createAdmin, query } from './stack.js';

const TRIP = 'Siargao surf week';
const ITEM = 'Island hopping to Naked Island';

/** The last path segment of the page's URL: the id of the trip or item on screen. */
function idInUrl(url: string): string {
  return new URL(url).pathname.split('/').at(-1) ?? '';
}

test('the first admin signs in with TOTP, creates a trip, adds an item and finds it audited', async ({
  page,
}) => {
  // A new username per run, so the test also passes against a stack that already has admins.
  const username = `ana-${Date.now().toString(36)}`;
  const password = 'walking-skeleton-e2e';

  // Exit criterion 1: `tribo admin create`, enrolment with a code from the printed key, sign-in.
  const admin = await createAdmin({
    username,
    displayName: 'Ana Reyes',
    password,
    codeFor: (key) => totpFor(key),
  });
  expect(admin.recoveryCodes).toHaveLength(10);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Authentication code').fill(totpFor(admin.key));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My trips' })).toBeVisible();
  await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();

  // Exit criterion 2: create a trip, add one item, read it back.
  await page.getByRole('link', { name: 'New trip' }).click();
  await page.getByLabel('Trip name').fill(TRIP);
  await page.getByLabel('First day').fill('2026-11-10');
  await page.getByLabel('Last day').fill('2026-11-16');
  await page.getByLabel('Currency').fill('PHP');
  await page.getByLabel('Time zone').fill('Asia/Manila');
  await page.getByRole('button', { name: 'Create trip' }).click();
  await expect(page.getByRole('heading', { name: TRIP })).toBeVisible();
  const tripId = idInUrl(page.url());

  await page.getByLabel('Title').fill(ITEM);
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page).toHaveURL(/\/items\/[^/]+$/);
  const itemId = idInUrl(page.url());

  // Read back from the server, not from the client's cache.
  await page.reload();
  await expect(page.getByRole('heading', { name: ITEM })).toBeVisible();
  await expect(page.getByText('Everyone on the trip')).toBeVisible();
  await page.getByRole('link', { name: `Back to ${TRIP}` }).click();
  await page.getByRole('link', { name: 'All trips' }).click();
  await expect(page.getByRole('link', { name: TRIP })).toBeVisible();

  // The item's create event is in the trip's chain, and the chain verifies.
  const tripChain = `trip:${decodeTypeId(ID_PREFIX.trip, tripId)}`;
  const itemUuid = decodeTypeId(ID_PREFIX.item, itemId);
  expect(
    await query(
      `SELECT chain_key, action, surface FROM audit.audit_events WHERE entity_id = '${itemUuid}'`,
    ),
  ).toEqual([`${tripChain}|create|web`]);

  const report = await auditVerify();
  expect(report).toMatch(new RegExp(`^${tripChain}  \\d+ events, head seq \\d+  intact$`, 'm'));
  expect(report).toMatch(/^All \d+ chains intact\.$/m);
});
