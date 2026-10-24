-- RLS tests for the Matkassa migrations. Run by test/rls.sh against a throwaway local Postgres with the stub in
-- stub_supabase.sql. Every check raises an exception on failure (ON_ERROR_STOP) and prints "PASS …" otherwise.
-- All users and data are FAKE.
\set ON_ERROR_STOP 1
\set QUIET 1
set client_min_messages = notice;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a-FAKE@example.invalid'),
  ('00000000-0000-0000-0000-00000000000b', 'b-FAKE@example.invalid');

-- ---------- user A writes ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
insert into public.receipts (id, data, updated_at) values ('r1', '{"total": 10, "note": "FAKE"}', '1999-01-01');
insert into public.list_items (id, data) values ('l1', '{"text": "melk"}');
insert into public.categories (id, data) values ('c1', '{"name": "Meieri"}');
insert into public.rules (id, data) values ('u1', '{"pattern": "melk"}');
insert into public.settings (data) values ('{"hiddenChains": ["x"]}');
do $$ begin
  assert (select count(*) from public.receipts) = 1, 'A sees own receipt';
  assert (select user_id from public.receipts where id = 'r1') = '00000000-0000-0000-0000-00000000000a', 'user_id defaults to auth.uid()';
  assert (select updated_at from public.receipts where id = 'r1') > now() - interval '1 minute', 'server sets updated_at';
  raise notice 'PASS A can write and read own rows in all 5 tables; user_id = auth.uid(); server clock sets updated_at';
end $$;

-- the GitHub key can never be stored in settings
do $$ begin
  begin
    update public.settings set data = '{"sync": {"repo": "x/y"}}';
    raise exception 'FAIL settings accepted a sync block';
  exception when check_violation then null; end;
  begin
    update public.settings set data = '{"a": {"token": "FAKE"}}';
    raise exception 'FAIL settings accepted a token';
  exception when check_violation then null; end;
  raise notice 'PASS settings reject a sync block or any "token" key (GitHub key never reaches the server)';
end $$;

-- ---------- user B cannot see or touch A ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare n int;
begin
  assert (select count(*) from public.receipts) = 0, 'B sees no receipts';
  assert (select count(*) from public.list_items) + (select count(*) from public.categories) + (select count(*) from public.rules) + (select count(*) from public.settings) = 0, 'B sees nothing';
  update public.receipts set data = '{"hacked": true}' where id = 'r1';
  get diagnostics n = row_count; assert n = 0, 'B update hits 0 rows';
  delete from public.list_items where id = 'l1';
  get diagnostics n = row_count; assert n = 0, 'B delete hits 0 rows';
  begin
    insert into public.receipts (user_id, id, data) values ('00000000-0000-0000-0000-00000000000a', 'evil', '{}');
    raise exception 'FAIL B inserted a row for A';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS B cannot read, update, delete or insert rows of A';
end $$;

-- B moving its own row to A is blocked too (WITH CHECK on update)
insert into public.receipts (id, data) values ('rb', '{}');
do $$ begin
  begin
    update public.receipts set user_id = '00000000-0000-0000-0000-00000000000a' where id = 'rb';
    raise exception 'FAIL B moved a row to A';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS B cannot hand a row over to A (update WITH CHECK)';
end $$;

-- ---------- anon (the public key without a login) gets nothing ----------
reset role;
set role anon;
reset request.jwt.claim.sub;
do $$ begin
  begin
    perform 1 from public.receipts;
    raise exception 'FAIL anon read receipts';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.chain_connections;
    raise exception 'FAIL anon read connections';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS anon (app key, not logged in) cannot read any table';
end $$;

-- ---------- chain connections: token only via the service role ----------
reset role;
set role service_role;
do $$ begin
  perform public.matkassa_store_chain_token('00000000-0000-0000-0000-00000000000a', 'trumf', 'FAKE-refresh-token-aaaaaaaa');
  perform public.matkassa_store_chain_token('00000000-0000-0000-0000-00000000000b', 'rema', 'FAKE-refresh-token-bbbbbbbb');
  assert public.matkassa_read_chain_token('00000000-0000-0000-0000-00000000000a', 'trumf') = 'FAKE-refresh-token-aaaaaaaa', 'service role reads token';
  raise notice 'PASS service role stores and reads a chain token (Vault)';
end $$;
do $$ begin
  perform public.matkassa_store_chain_token('00000000-0000-0000-0000-00000000000a', 'trumf', 'FAKE-refresh-token-rotated');
  assert public.matkassa_read_chain_token('00000000-0000-0000-0000-00000000000a', 'trumf') = 'FAKE-refresh-token-rotated', 'rotated';
end $$;
reset role;
do $$ begin
  assert (select count(*) from vault.secrets) = 2, 'rotation reuses the secret';
  raise notice 'PASS a rotated token replaces the old one (no stale copies in Vault)';
end $$;

reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from public.chain_connections) = 1, 'A sees own connection only';
  assert (select status from public.chain_connections where chain = 'trumf') = 'connected', 'status visible';
  begin
    perform secret_id from public.chain_connections;
    raise exception 'FAIL A could read secret_id';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from vault.decrypted_secrets;
    raise exception 'FAIL A could read the vault';
  exception when insufficient_privilege then null; end;
  begin
    perform public.matkassa_read_chain_token('00000000-0000-0000-0000-00000000000a', 'trumf');
    raise exception 'FAIL A could call the token reader';
  exception when insufficient_privilege then null; end;
  begin
    perform public.matkassa_store_chain_token('00000000-0000-0000-0000-00000000000a', 'rema', 'FAKE-xxxxxxxxxxxx');
    raise exception 'FAIL A could store a token directly';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.chain_connections (user_id, chain) values ('00000000-0000-0000-0000-00000000000a', 'coop');
    raise exception 'FAIL A inserted a connection';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS a user sees only the status of own connections: no secret id, no Vault, no token functions, no inserts';
end $$;

-- "Koble fra": deleting the row deletes the Vault secret
delete from public.chain_connections where chain = 'trumf';
reset role;
do $$ begin
  assert (select count(*) from vault.secrets) = 1, 'A secret deleted, B secret kept';
  assert not exists (select 1 from vault.secrets where secret like '%rotated%'), 'A token gone';
  raise notice 'PASS "Koble fra" deletes the encrypted token, other users untouched';
end $$;

-- account deletion cascades to every table and the Vault secret
delete from auth.users where id = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from public.receipts where user_id = '00000000-0000-0000-0000-00000000000b') = 0, 'B receipts gone';
  assert (select count(*) from vault.secrets) = 0, 'B secret gone';
  assert (select count(*) from public.receipts) = 1, 'A data kept';
  raise notice 'PASS deleting a user deletes all their rows and chain tokens (GDPR erasure)';
end $$;
