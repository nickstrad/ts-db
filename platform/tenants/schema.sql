-- Central multitenancy schema (MT-01). Idempotent: safe to re-apply. Applied by `make db-migrate`.

CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY,
  slug       text UNIQUE NOT NULL,
  name       text,
  status     text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  key_hash   text UNIQUE NOT NULL,
  prefix     text,
  name       text,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash);

-- MT-08: the full auth migration creates "user" first. The legacy registry-only
-- bootstrap must continue to work without auth installed.
DO $$
BEGIN
  IF to_regclass('"user"') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS memberships (
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS memberships_tenant_id_idx ON memberships (tenant_id);
  END IF;
END
$$;
