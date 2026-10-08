// Isolated in-memory Postgres (PGlite, WebAssembly) that replays every
// migration in supabase/migrations with minimal stand-ins for the Supabase
// auth/storage schemas and API roles. It never connects to a hosted database.
//
// Limits: auth.uid() and the JWT claims are simulated per transaction, and the
// API roles are emulated with SET ROLE, so PostgREST, GoTrue and Storage
// themselves are not exercised.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url))

const BOOTSTRAP = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE SCHEMA extensions;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
  allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid,
  created_at timestamptz DEFAULT now(), metadata jsonb
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
  $$ SELECT string_to_array(name, '/') $$;
GRANT USAGE ON SCHEMA public, auth, storage, extensions TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
`

export async function createDb() {
  const db = new PGlite()
  await db.exec(BOOTSTRAP)
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`)
    }
  }
  return db
}

// Runs fn in a transaction as an API caller, the way PostgREST would:
// who = { role: 'anon' } | { role: 'service_role' } | { role: 'authenticated', id }.
export async function as(db, who, fn) {
  return db.transaction(async (tx) => {
    const claims = who.role === 'authenticated' ? { role: 'authenticated', sub: who.id } : { role: who.role }
    await tx.query(
      `SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)`,
      [JSON.stringify(claims), who.id ?? '', claims.role],
    )
    await tx.exec(`SET LOCAL ROLE ${claims.role}`)
    return fn(tx)
  })
}

export async function one(q, sql, params) {
  return (await q.query(sql, params)).rows[0]
}
