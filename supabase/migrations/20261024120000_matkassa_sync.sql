-- Matkassa: per-user sync tables with row-level security.
-- Run once in the Supabase SQL editor (or `supabase db push`). Safe to re-run.
--
-- Model: every synced thing is a row {user_id, id, data jsonb, updated_at, deleted}. The app is local-first: it keeps
-- working without an account, and on sync it pushes rows it changed and pulls rows changed since its last pull.
-- `deleted` is a tombstone so a delete on one device reaches the others.
--
-- Security: RLS on every table, every policy is "user_id = auth.uid()". The anon key in the app can do nothing
-- without a logged-in user's JWT, and a user can only ever see or change their own rows.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.receipts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (length(id) between 1 and 200),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  primary key (user_id, id)
);

create table if not exists public.list_items (like public.receipts including all);
create table if not exists public.categories (like public.receipts including all);
create table if not exists public.rules (like public.receipts including all);

create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- `like … including all` copies defaults, checks and the primary key, but not the foreign key: add it.
do $$
declare t text;
begin
  foreach t in array array['list_items', 'categories', 'rules'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_user_fk') then
      execute format('alter table public.%I add constraint %I foreign key (user_id) references auth.users (id) on delete cascade', t, t || '_user_fk');
    end if;
  end loop;
end $$;

-- Pull queries are "updated_at > last pull" per user.
create index if not exists receipts_user_updated on public.receipts (user_id, updated_at);
create index if not exists list_items_user_updated on public.list_items (user_id, updated_at);
create index if not exists categories_user_updated on public.categories (user_id, updated_at);
create index if not exists rules_user_updated on public.rules (user_id, updated_at);

-- The server clock decides updated_at (a phone with a wrong clock can't hide its changes from a pull).
create or replace function public.matkassa_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['receipts', 'list_items', 'categories', 'rules', 'settings'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before insert or update on public.%I for each row execute function public.matkassa_touch()', t);
  end loop;
end $$;

-- Size guard: one row can't be used to store something huge (a receipt with lines is a few kB).
do $$
declare t text;
begin
  foreach t in array array['receipts', 'list_items', 'categories', 'rules', 'settings'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_data_size') then
      execute format('alter table public.%I add constraint %I check (pg_column_size(data) < 200000)', t, t || '_data_size');
    end if;
  end loop;
end $$;

-- The GitHub sync key must never reach the server: reject settings that contain it.
alter table public.settings drop constraint if exists settings_no_token;
alter table public.settings add constraint settings_no_token check (not (data ? 'sync') and not jsonb_path_exists(data, 'strict $.**.token'));

-- ---------- row-level security ----------
do $$
declare t text;
begin
  foreach t in array array['receipts', 'list_items', 'categories', 'rules', 'settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_select on public.%I', t);
    execute format('drop policy if exists own_insert on public.%I', t);
    execute format('drop policy if exists own_update on public.%I', t);
    execute format('drop policy if exists own_delete on public.%I', t);
    execute format('create policy own_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy own_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy own_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy own_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
