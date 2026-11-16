-- Local dev roles and databases. On Neon, create the same roles once via SQL
-- (see docs/DEPLOYMENT.md) with strong passwords.
CREATE ROLE app_owner LOGIN PASSWORD 'app_owner';
CREATE ROLE app_user  LOGIN PASSWORD 'app_user' NOBYPASSRLS;

CREATE DATABASE sge      OWNER app_owner;
CREATE DATABASE sge_test OWNER app_owner;
-- Identity tables (schema "auth") are reachable only by this role (Better Auth).
CREATE ROLE auth_user LOGIN PASSWORD 'auth_user' NOBYPASSRLS;
CREATE DATABASE sge_test_core OWNER app_owner;
