-- Dev demo trip, run by the `seed` service as tribo_app after the app has migrated.
-- Fixed ids and ON CONFLICT DO NOTHING make it safe to run on every `pnpm dev:up`.
-- Plain SQL for now: once the skeleton operations land (task 10) this becomes a script
-- that goes through the services, so the rows get audit events and snapshots too.
-- Invented people and places only.

-- Dev-only password 'demo-password-dev' (Argon2id); no MFA.
INSERT INTO tribo.users (id, username, password_hash)
VALUES ('0192f000-0000-7000-8000-000000000001', 'demo',
        '$argon2id$v=19$m=19456,t=2,p=1$UB+WCnHALFaJ8LshO3sUWQ$kvtHG8eo6/N7Yis+abmH82yeY1z4/dZG3GaQ6jWg9BA')
ON CONFLICT DO NOTHING;
-- Volumes seeded before task 9 hold '!' (no password).
UPDATE tribo.users
SET password_hash = '$argon2id$v=19$m=19456,t=2,p=1$UB+WCnHALFaJ8LshO3sUWQ$kvtHG8eo6/N7Yis+abmH82yeY1z4/dZG3GaQ6jWg9BA'
WHERE id = '0192f000-0000-7000-8000-000000000001' AND password_hash = '!';

INSERT INTO tribo.persons (id, user_id, display_name, created_by)
VALUES
  ('0192f000-0000-7000-8000-000000000101', '0192f000-0000-7000-8000-000000000001', 'Demo Organizer',
   '0192f000-0000-7000-8000-000000000001'),
  ('0192f000-0000-7000-8000-000000000102', NULL, 'Guest Traveller',
   '0192f000-0000-7000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO tribo.trips (id, name, start_date, end_date, currency, timezone, status, created_by)
VALUES ('0192f000-0000-7000-8000-000000000201', 'Demo island weekend', '2026-11-11', '2026-11-14',
        'PHP', 'Asia/Manila', 'planning', '0192f000-0000-7000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO tribo.memberships (id, trip_id, person_id, trip_role, created_by)
VALUES
  ('0192f000-0000-7000-8000-000000000301', '0192f000-0000-7000-8000-000000000201',
   '0192f000-0000-7000-8000-000000000101', 'owner', '0192f000-0000-7000-8000-000000000001'),
  ('0192f000-0000-7000-8000-000000000302', '0192f000-0000-7000-8000-000000000201',
   '0192f000-0000-7000-8000-000000000102', 'member', '0192f000-0000-7000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO tribo.items
  (id, trip_id, type, title, status, start_at, start_tz, end_at, end_tz, start_date,
   visibility, owner_membership_id, created_by)
VALUES
  ('0192f000-0000-7000-8000-000000000401', '0192f000-0000-7000-8000-000000000201', 'transport',
   'Morning ferry to the island', 'booked',
   '2026-11-10 23:40+00', 'Asia/Manila', '2026-11-11 01:30+00', 'Asia/Manila', NULL,
   'shared', '0192f000-0000-7000-8000-000000000301', '0192f000-0000-7000-8000-000000000001'),
  ('0192f000-0000-7000-8000-000000000402', '0192f000-0000-7000-8000-000000000201', 'lodging',
   'Beach guest house', 'confirmed', NULL, NULL, NULL, NULL, '2026-11-11',
   'shared', '0192f000-0000-7000-8000-000000000301', '0192f000-0000-7000-8000-000000000001'),
  ('0192f000-0000-7000-8000-000000000403', '0192f000-0000-7000-8000-000000000201', 'note',
   'Organizer notes', 'open', NULL, NULL, NULL, NULL, NULL,
   'private', '0192f000-0000-7000-8000-000000000301', '0192f000-0000-7000-8000-000000000001'),
  ('0192f000-0000-7000-8000-000000000404', '0192f000-0000-7000-8000-000000000201', 'activity',
   'Waterfall hike (invite only)', 'planned', NULL, NULL, NULL, NULL, '2026-11-12',
   'selected', '0192f000-0000-7000-8000-000000000301', '0192f000-0000-7000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO tribo.item_shares (item_id, trip_id, membership_id, created_by)
VALUES ('0192f000-0000-7000-8000-000000000404', '0192f000-0000-7000-8000-000000000201',
        '0192f000-0000-7000-8000-000000000302', '0192f000-0000-7000-8000-000000000001')
ON CONFLICT DO NOTHING;
