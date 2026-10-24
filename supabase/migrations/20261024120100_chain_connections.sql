-- Matkassa: "Koble til" a grocery chain for the weekly server pull (for Ole and testers only, see SUPABASE.md).
--
-- The chain's refresh token/session is stored in Supabase Vault (encrypted at rest). It is:
--   * written only by the `connect` Edge Function (service role), never by the app directly;
--   * readable only by the service role (the weekly `fetch-receipts` function), never sent back to any client;
--   * revocable: deleting the connection row ("Koble fra" in the app) deletes the Vault secret too;
--   * covered by RLS: a user sees only the status of their own connections, never the secret id.
-- Requires the Vault extension (on by default in Supabase projects).

create table if not exists public.chain_connections (
  user_id uuid not null references auth.users (id) on delete cascade,
  chain text not null check (chain in ('trumf', 'rema', 'coop')),
  status text not null default 'connected' check (status in ('connected', 'failing', 'expired')),
  connected_at timestamptz not null default now(),
  last_fetch_at timestamptz,
  last_error text check (length(last_error) < 300),
  secret_id uuid,
  primary key (user_id, chain)
);

alter table public.chain_connections enable row level security;
drop policy if exists own_select on public.chain_connections;
drop policy if exists own_delete on public.chain_connections;
create policy own_select on public.chain_connections for select to authenticated using (user_id = (select auth.uid()));
create policy own_delete on public.chain_connections for delete to authenticated using (user_id = (select auth.uid()));
-- No insert/update policy: only the service role (Edge Functions) creates or updates connections.
revoke all on public.chain_connections from anon, authenticated;
grant select (user_id, chain, status, connected_at, last_fetch_at, last_error) on public.chain_connections to authenticated;
grant delete on public.chain_connections to authenticated;

-- "Koble fra": the Vault secret goes with the row (also on account deletion, via the cascade).
create or replace function public.matkassa_drop_chain_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end $$;
revoke all on function public.matkassa_drop_chain_secret() from public, anon, authenticated;

drop trigger if exists drop_secret on public.chain_connections;
create trigger drop_secret after delete on public.chain_connections
  for each row execute function public.matkassa_drop_chain_secret();

-- Service-role helpers used by the Edge Functions. Not callable by anon/authenticated.
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
    update public.chain_connections set status = 'connected', last_error = null where user_id = p_user and chain = p_chain;
  else
    new_id := vault.create_secret(p_token, 'matkassa:' || p_chain || ':' || p_user::text, 'Matkassa chain session');
    insert into public.chain_connections (user_id, chain, secret_id) values (p_user, p_chain, new_id)
      on conflict (user_id, chain) do update set secret_id = excluded.secret_id, status = 'connected', last_error = null, connected_at = now();
  end if;
end $$;

create or replace function public.matkassa_read_chain_token(p_user uuid, p_chain text) returns text
language sql security definer set search_path = '' stable as $$
  select s.decrypted_secret
  from public.chain_connections c join vault.decrypted_secrets s on s.id = c.secret_id
  where c.user_id = p_user and c.chain = p_chain;
$$;

create or replace function public.matkassa_fetch_result(p_user uuid, p_chain text, p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.chain_connections
  set last_fetch_at = now(),
      last_error = left(p_error, 290),
      status = case when p_error is null then 'connected' when p_error ilike '%expired%' then 'expired' else 'failing' end
  where user_id = p_user and chain = p_chain;
$$;

revoke all on function public.matkassa_store_chain_token(uuid, text, text) from public, anon, authenticated;
revoke all on function public.matkassa_read_chain_token(uuid, text) from public, anon, authenticated;
revoke all on function public.matkassa_fetch_result(uuid, text, text) from public, anon, authenticated;
grant execute on function public.matkassa_store_chain_token(uuid, text, text) to service_role;
grant execute on function public.matkassa_read_chain_token(uuid, text) to service_role;
grant execute on function public.matkassa_fetch_result(uuid, text, text) to service_role;
