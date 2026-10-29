-- Matkassa: user profiles + chain status reported from the user's own device (the "Koble til REMA" button).
-- Run after the two earlier migrations (SQL Editor or `supabase db push`). Safe to re-run.
--
-- profiles: one row per account, made automatically at sign-up. Only a display name, the chosen chains and when the
-- account was made: NO e-mail, phone number, address or anything else sensitive (that stays in auth.users, which
-- the app never reads directly).
--
-- chain_connections.source: who keeps the chain login. 'server' = the weekly Edge Function (token in Vault, as
-- before); 'mac-helper' = the user's own Mac (ingest/helper.py, token in ~/.rema1000 and NEVER sent here);
-- 'ios' = a future iPhone app (token in the iPhone Keychain, never sent here). For 'mac-helper' and 'ios' the row
-- only holds the STATUS, so the app on the phone can show "Koblet via Mac-en · hentet …".

-- ---------- profiles ----------
create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text check (display_name is null or length(display_name) between 1 and 60),
  chains text[] not null default '{}' check (cardinality(chains) <= 50 and length(array_to_string(chains, ',')) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists touch on public.profiles;
create trigger touch before insert or update on public.profiles for each row execute function public.matkassa_touch();

alter table public.profiles enable row level security;
drop policy if exists own_select on public.profiles;
drop policy if exists own_insert on public.profiles;
drop policy if exists own_update on public.profiles;
drop policy if exists own_delete on public.profiles;
create policy own_select on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy own_insert on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy own_update on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_delete on public.profiles for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.profiles from anon, authenticated;
-- Column grants: a user can change their name and chains, never user_id or created_at.
grant select, delete on public.profiles to authenticated;
grant insert (display_name, chains), update (display_name, chains) on public.profiles to authenticated;

-- A profile for every new account (and for accounts made before this migration).
create or replace function public.matkassa_new_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function public.matkassa_new_profile() from public, anon, authenticated;
drop trigger if exists matkassa_new_profile on auth.users;
create trigger matkassa_new_profile after insert on auth.users for each row execute function public.matkassa_new_profile();
insert into public.profiles (user_id) select id from auth.users on conflict (user_id) do nothing;

-- ---------- chain status from the user's own device ----------
alter table public.chain_connections add column if not exists source text not null default 'server'
  check (source in ('server', 'mac-helper', 'ios'));
grant select (source) on public.chain_connections to authenticated;

-- The device reports its own status. Only for the logged-in user, never a token, never touches the Vault secret.
create or replace function public.matkassa_report_chain_status(p_chain text, p_status text, p_synced boolean default false,
                                                               p_error text default null, p_source text default 'mac-helper')
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not logged in' using errcode = '42501'; end if;
  if p_chain not in ('rema', 'trumf', 'coop') then raise exception 'unknown chain'; end if;
  if p_status not in ('connected', 'failing', 'expired') then raise exception 'unknown status'; end if;
  if p_source not in ('mac-helper', 'ios') then raise exception 'unknown source'; end if;
  insert into public.chain_connections (user_id, chain, status, source, last_fetch_at, last_error)
    values (uid, p_chain, p_status, p_source, case when p_synced then now() end, left(p_error, 290))
  on conflict (user_id, chain) do update
    set status = excluded.status,
        source = excluded.source,
        last_fetch_at = coalesce(excluded.last_fetch_at, public.chain_connections.last_fetch_at),
        last_error = excluded.last_error;
end $$;
revoke all on function public.matkassa_report_chain_status(text, text, boolean, text, text) from public, anon;
grant execute on function public.matkassa_report_chain_status(text, text, boolean, text, text) to authenticated;

-- When the server takes over a chain (cloud.py connect → Edge Function), the row's source becomes 'server'.
-- Same function as in 20261024120100, plus `source`.
create or replace function public.matkassa_store_chain_token(p_user uuid, p_chain text, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  old_id uuid;
  new_id uuid;
begin
  if p_token is null or length(p_token) < 10 or length(p_token) > 20000 then
    raise exception 'invalid token';
  end if;
  select secret_id into old_id from public.chain_connections where user_id = p_user and chain = p_chain;
  if old_id is not null then
    perform vault.update_secret(old_id, p_token);
    update public.chain_connections set status = 'connected', source = 'server', last_error = null where user_id = p_user and chain = p_chain;
  else
    new_id := vault.create_secret(p_token, 'matkassa:' || p_chain || ':' || p_user::text, 'Matkassa chain session');
    insert into public.chain_connections (user_id, chain, secret_id, source) values (p_user, p_chain, new_id, 'server')
      on conflict (user_id, chain) do update set secret_id = excluded.secret_id, source = 'server', status = 'connected', last_error = null, connected_at = now();
  end if;
end $$;
