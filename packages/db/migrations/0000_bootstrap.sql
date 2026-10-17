-- Tribo — 0000_bootstrap.sql
-- Run once per instance as a superuser (e.g. the postgres image's init script).
-- Creates the two roles and the database; everything else is owned by tribo_owner
-- and created by the numbered migrations the app runs at start-up.
--
--   tribo_owner  owns every object, runs migrations, never used for requests
--   tribo_app    the role the app process uses for requests and daily jobs
--
-- Passwords come from Docker secrets, set outside this file:
--   ALTER ROLE tribo_owner PASSWORD '...';  ALTER ROLE tribo_app PASSWORD '...';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tribo_owner') THEN
    CREATE ROLE tribo_owner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tribo_app') THEN
    CREATE ROLE tribo_app LOGIN;
  END IF;
END $$;

-- CREATE DATABASE cannot run inside DO; run it from psql:
--   CREATE DATABASE tribo OWNER tribo_owner ENCODING 'UTF8' TEMPLATE template0;
--   \c tribo
--   REVOKE ALL ON DATABASE tribo FROM PUBLIC;
--   GRANT CONNECT ON DATABASE tribo TO tribo_app;
--   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
