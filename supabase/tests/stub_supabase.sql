-- Minimal stand-in for the parts of a Supabase database the migrations rely on, so RLS can be tested on a plain
-- local Postgres (test/rls.sh). Not used in production. auth.uid() reads the JWT subject the same way Supabase does.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
-- The columns supabase/seed.sql fills in (same names and types as Supabase's auth.users / auth.identities).
create table auth.users (
  id uuid primary key, email text, instance_id uuid, aud text, role text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz,
  confirmation_token text, recovery_token text, email_change_token_new text, email_change text
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade,
  provider_id text not null, provider text not null, identity_data jsonb not null,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz, unique (provider_id, provider)
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Vault stand-in: same function names and view as supabase_vault (without the encryption, which is Supabase's job).
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
language sql as $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void
language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
revoke all on schema vault from public;
grant usage on schema vault to service_role;
