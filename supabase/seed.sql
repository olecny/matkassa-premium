-- FAKE test data for Matkassa: 3 FAKE users with FAKE receipts, list items, profiles and chain status.
-- NOT real people, NOT real purchases. For local testing (test/rls.sh) and for trying the dashboard / app once.
-- Run AFTER the migrations, in the SQL Editor (as postgres). Safe to run twice: nothing is duplicated.
-- Remove again: delete from auth.users where email like '%-FAKE@example.invalid';   (cascades to all their rows)
--
-- Login in the app (only if you want to try it): fake-anna-FAKE@example.invalid / FAKE-testpassord-123
-- (all three have that FAKE password; .invalid addresses can never receive e-mail).

-- ---------- 3 FAKE accounts ----------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000'::uuid, u.id::uuid, 'authenticated', 'authenticated', u.email,
       -- bcrypt of the FAKE password above (made with pgcrypto crypt(…, gen_salt('bf', 10)))
       '$2a$10$6Q4ewGPCV9jeeTOjW98wuOk.850u9R1BhYDvk4kB1NWLtTJIzj30i', now(),
       '{"provider": "email", "providers": ["email"]}'::jsonb, '{"fake": true}'::jsonb, now(), now(), '', '', '', ''
from (values
  ('fa4e0000-0000-4000-8000-000000000001', 'fake-anna-FAKE@example.invalid'),
  ('fa4e0000-0000-4000-8000-000000000002', 'fake-bjorn-FAKE@example.invalid'),
  ('fa4e0000-0000-4000-8000-000000000003', 'fake-cecilie-FAKE@example.invalid')
) as u (id, email)
on conflict (id) do nothing;

insert into auth.identities (user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select id, id::text, 'email', jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true), now(), now(), now()
from auth.users where id::text like 'fa4e0000-0000-4000-8000-00000000000_'
on conflict (provider_id, provider) do nothing;

-- ---------- profiles (made by the sign-up trigger; fill in FAKE names) ----------
insert into public.profiles (user_id, display_name, chains) values
  ('fa4e0000-0000-4000-8000-000000000001', 'FAKE Anna (test)', '{rema,kiwi}'),
  ('fa4e0000-0000-4000-8000-000000000002', 'FAKE Bjørn (test)', '{coop-extra}'),
  ('fa4e0000-0000-4000-8000-000000000003', 'FAKE Cecilie (test)', '{}')
on conflict (user_id) do update set display_name = excluded.display_name, chains = excluded.chains;

-- ---------- FAKE receipts ----------
insert into public.receipts (user_id, id, data) values
  ('fa4e0000-0000-4000-8000-000000000001', 'rema-FAKE-1001', '{"id": "rema-FAKE-1001", "source": "rema", "chain": "REMA 1000", "store": "REMA 1000 TESTGATA (FAKE)", "date": "2026-10-20", "time": "17:32", "total": 154.70, "currency": "NOK", "_note": "FAKE",
    "lines": [{"name": "TINE LETTMELK 1L (FAKE)", "amount": 24.90, "group": "MELK"}, {"name": "GROVBRØD (FAKE)", "amount": 39.90}, {"name": "BANANER (FAKE)", "amount": 29.90}, {"name": "KYLLINGFILET 400G (FAKE)", "amount": 60.00}]}'),
  ('fa4e0000-0000-4000-8000-000000000001', 'rema-FAKE-1002', '{"id": "rema-FAKE-1002", "source": "rema", "chain": "REMA 1000", "store": "REMA 1000 TESTGATA (FAKE)", "date": "2026-10-27", "total": 89.80, "currency": "NOK", "_note": "FAKE",
    "lines": [{"name": "PASTA 1KG (FAKE)", "amount": 29.90}, {"name": "TOMATER (FAKE)", "amount": 59.90}]}'),
  ('fa4e0000-0000-4000-8000-000000000002', 'coop-FAKE-2001', '{"id": "coop-FAKE-2001", "source": "coop", "chain": "Coop Extra", "store": "COOP EXTRA TESTVEIEN (FAKE)", "date": "2026-10-22", "total": 212.40, "currency": "NOK", "_note": "FAKE",
    "lines": [{"name": "KAFFE 250G (FAKE)", "amount": 69.90}, {"name": "OST NORVEGIA (FAKE)", "amount": 112.60}, {"name": "EPLER (FAKE)", "amount": 29.90}]}'),
  ('fa4e0000-0000-4000-8000-000000000003', 'manual-FAKE-3001', '{"id": "manual-FAKE-3001", "source": "manual", "chain": "TESTBUTIKK (FAKE)", "store": "TESTBUTIKK (FAKE)", "date": "2026-10-25", "total": 45.00, "currency": "NOK", "_note": "FAKE", "category": "annet"}')
on conflict (user_id, id) do nothing;

insert into public.list_items (user_id, id, data) values
  ('fa4e0000-0000-4000-8000-000000000001', 'list-FAKE-1', '{"text": "melk (FAKE)", "done": false}'),
  ('fa4e0000-0000-4000-8000-000000000002', 'list-FAKE-2', '{"text": "kaffe (FAKE)", "done": true}')
on conflict (user_id, id) do nothing;

-- ---------- chain status (no tokens: status rows only, as the Mac helper reports them) ----------
insert into public.chain_connections (user_id, chain, status, source, last_fetch_at, secret_id) values
  ('fa4e0000-0000-4000-8000-000000000001', 'rema', 'connected', 'mac-helper', now() - interval '2 days', null),
  ('fa4e0000-0000-4000-8000-000000000002', 'rema', 'expired', 'mac-helper', now() - interval '40 days', null)
on conflict (user_id, chain) do nothing;
