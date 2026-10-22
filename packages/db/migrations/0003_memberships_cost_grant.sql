-- Tribo — 0003_memberships_cost_grant.sql
-- tribo.memberships.can_view_costs ("only meaningful for viewers", 0001_init.sql) is a
-- viewer's cost grant alone (decision 0007): every other role reads costs anyway. The
-- members write path and invites.accept both keep it; one row can state the rule, so the
-- database declares it too (rule 2) and no later writer can store a grant on another role.

ALTER TABLE tribo.memberships
  ADD CONSTRAINT memberships_cost_grant_viewer_only
  CHECK (NOT can_view_costs OR trip_role = 'viewer');

COMMENT ON CONSTRAINT memberships_cost_grant_viewer_only ON tribo.memberships IS
  'Decision 0007: can_view_costs is true only on viewer rows. members.setRole drops the grant '
  'when a viewer moves to another role; an invite claim keeps it only while the role stays viewer.';
