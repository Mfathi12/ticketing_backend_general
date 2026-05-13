-- One-time PostgreSQL fix: ENUM columns that omit `owner` (or drift from app code) cause 500
-- when promoting a member to company owner. Converts membership + global role to VARCHAR.
--
-- Usage: psql "$DATABASE_URL" -f scripts/sql/postgres-role-columns-to-varchar.sql

BEGIN;

ALTER TABLE user_companies
  ALTER COLUMN "companyRole" DROP DEFAULT;
ALTER TABLE user_companies
  ALTER COLUMN "companyRole" TYPE VARCHAR(64) USING ("companyRole"::text);
ALTER TABLE user_companies
  ALTER COLUMN "companyRole" SET DEFAULT 'user';

ALTER TABLE company_members
  ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE company_members
  ALTER COLUMN "role" TYPE VARCHAR(64) USING ("role"::text);
ALTER TABLE company_members
  ALTER COLUMN "role" SET DEFAULT 'user';

ALTER TABLE users
  ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users
  ALTER COLUMN role TYPE VARCHAR(64) USING (role::text);
ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'user';

COMMIT;
