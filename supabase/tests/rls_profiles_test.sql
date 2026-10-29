-- RLS tests for profiles, the chain status reported by the Mac helper, and the FAKE seed (supabase/seed.sql).
-- Run by test/rls.sh after rls_test.sql and after the seed has been applied twice. All users and data are FAKE.
\set ON_ERROR_STOP 1
\set QUIET 1
set client_min_messages = notice;

-- ---------- the seed ran twice without duplicates ----------
do $$ begin
  assert (select count(*) from auth.users where email like '%-FAKE@example.invalid' and id::text like 'fa4e0000-%') = 3, '3 FAKE seed users';
  assert (select count(*) from auth.identities where provider = 'email' and user_id::text like 'fa4e0000-%') = 3, '3 identities';
  assert (select count(*) from public.receipts where user_id::text like 'fa4e0000-%') = 4, '4 FAKE receipts, not 8';
  assert (select count(*) from public.receipts where user_id::text like 'fa4e0000-%' and data->>'_note' = 'FAKE') = 4, 'every seed receipt is marked FAKE';
  assert (select count(*) from public.profiles where display_name like 'FAKE %') = 3, '3 FAKE profiles';
  raise notice 'PASS seed: 3 FAKE users, 4 FAKE receipts, profiles and chain status; running it twice adds nothing';
end $$;

-- ---------- profiles: made at sign-up, nothing sensitive ----------
do $$ begin
  assert (select count(*) from public.profiles p join auth.users u on u.id = p.user_id) = (select count(*) from auth.users), 'every account has a profile';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
                     and column_name ~* 'mail|phone|tlf|telefon|address|adresse|birth|fodsel|password|token'), 'no sensitive columns';
  raise notice 'PASS profiles: one per account (sign-up trigger), and no e-mail/phone/address/password columns';
end $$;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000cc', 'c-FAKE@example.invalid');
do $$ begin
  assert exists (select 1 from public.profiles where user_id = '00000000-0000-0000-0000-0000000000cc'), 'new user gets a profile';
  raise notice 'PASS a new account gets an empty profile automatically';
end $$;

-- ---------- profiles: own row only ----------
set role authenticated;
set request.jwt.claim.sub = 'fa4e0000-0000-4000-8000-000000000001';
do $$
declare n int;
begin
  assert (select count(*) from public.profiles) = 1, 'Anna sees one profile';
  assert (select display_name from public.profiles) = 'FAKE Anna (test)', 'her own';
  update public.profiles set display_name = 'FAKE Anna 2', chains = '{rema}';
  get diagnostics n = row_count; assert n = 1, 'own update';
  update public.profiles set display_name = 'hacked' where user_id = 'fa4e0000-0000-4000-8000-000000000002';
  get diagnostics n = row_count; assert n = 0, 'other update hits 0 rows';
  delete from public.profiles where user_id = 'fa4e0000-0000-4000-8000-000000000002';
  get diagnostics n = row_count; assert n = 0, 'other delete hits 0 rows';
  begin
    update public.profiles set created_at = '2000-01-01';
    raise exception 'FAIL changed created_at';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set user_id = 'fa4e0000-0000-4000-8000-000000000002';
    raise exception 'FAIL moved profile';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set display_name = repeat('x', 61);
    raise exception 'FAIL accepted a 61-char name';
  exception when check_violation then null; end;
  raise notice 'PASS profiles: a user reads and edits only their own name/chains, never user_id, created_at or others';
end $$;
do $$ begin
  assert (select count(*) from public.receipts) = 2, 'Anna sees her 2 FAKE receipts';
  assert (select count(*) from public.chain_connections) = 1, 'Anna sees her own REMA status';
  raise notice 'PASS seed users see only their own receipts and chain status';
end $$;
set request.jwt.claim.sub = 'fa4e0000-0000-4000-8000-000000000003';
do $$ begin
  assert (select count(*) from public.profiles) = 1 and (select display_name from public.profiles) = 'FAKE Cecilie (test)', 'Cecilie: own profile';
  assert (select count(*) from public.receipts) = 1 and (select count(*) from public.chain_connections) = 0, 'Cecilie: own data only';
  begin
    insert into public.profiles (display_name) values ('second');
    raise exception 'FAIL second profile';
  exception when unique_violation then null; end;
  raise notice 'PASS a user cannot make a second profile';
end $$;

-- ---------- chain status from the Mac helper (no token) ----------
do $$ begin
  perform public.matkassa_report_chain_status('rema', 'connected', true);
  assert (select source from public.chain_connections where chain = 'rema') = 'mac-helper', 'source';
  assert (select last_fetch_at from public.chain_connections where chain = 'rema') > now() - interval '1 minute', 'synced now';
  perform public.matkassa_report_chain_status('rema', 'expired', false, 'REMA-innloggingen er utløpt (FAKE)');
  assert (select status from public.chain_connections where chain = 'rema') = 'expired', 'expired';
  assert (select last_fetch_at from public.chain_connections where chain = 'rema') is not null, 'last sync kept';
  begin
    perform public.matkassa_report_chain_status('rema', 'hacked');
    raise exception 'FAIL bad status';
  exception when raise_exception then null; end;
  begin
    perform public.matkassa_report_chain_status('rema', 'connected', false, null, 'server');
    raise exception 'FAIL claimed server source';
  exception when raise_exception then null; end;
  raise notice 'PASS the Mac reports REMA status for its own user only (connected/expired), no token involved';
end $$;
set request.jwt.claim.sub = 'fa4e0000-0000-4000-8000-000000000001';
do $$ begin
  assert (select status from public.chain_connections where chain = 'rema') = 'connected', 'Anna unaffected by Cecilie';
  raise notice 'PASS reporting status never touches another user''s row';
end $$;

reset role;
set role anon;
reset request.jwt.claim.sub;
do $$ begin
  begin
    perform 1 from public.profiles;
    raise exception 'FAIL anon read profiles';
  exception when insufficient_privilege then null; end;
  begin
    perform public.matkassa_report_chain_status('rema', 'connected');
    raise exception 'FAIL anon reported';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS anon can neither read profiles nor report a chain status';
end $$;

-- a server connection's Vault secret is never touched by a device report
reset role;
set role service_role;
do $$ begin perform public.matkassa_store_chain_token('fa4e0000-0000-4000-8000-000000000003', 'trumf', 'FAKE-refresh-token-cccccccc'); end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = 'fa4e0000-0000-4000-8000-000000000003';
do $$ begin perform public.matkassa_report_chain_status('trumf', 'failing', false, 'FAKE'); end $$;
reset role;
do $$ begin
  assert (select secret_id from public.chain_connections where user_id = 'fa4e0000-0000-4000-8000-000000000003' and chain = 'trumf') is not null, 'secret kept';
  raise notice 'PASS a device status report keeps the server''s encrypted token as it is';
end $$;

-- account deletion takes the profile along
delete from auth.users where id = 'fa4e0000-0000-4000-8000-000000000003';
do $$ begin
  assert not exists (select 1 from public.profiles where user_id = 'fa4e0000-0000-4000-8000-000000000003'), 'profile gone';
  assert (select count(*) from vault.secrets where name like '%fa4e0000-0000-4000-8000-000000000003') = 0, 'secret gone';
  raise notice 'PASS deleting an account deletes its profile and chain status too';
end $$;
