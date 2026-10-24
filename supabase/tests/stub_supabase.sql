-- Minimal stand-in for the parts of a Supabase database the migrations rely on, so RLS can be tested on a plain
-- local Postgres (test/rls.sh). Not used in production. auth.uid() reads the JWT subject the same way Supabase does.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
create table auth.users (id uuid primary key, email text);
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
