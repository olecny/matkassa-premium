-- Weekly server pull: every Sunday 18:00 UTC (20:00 Norwegian summer time, 19:00 winter time).
-- NOT a migration: run this by hand in the SQL editor only after the `fetch-receipts` Edge Function is deployed and
-- the two Vault secrets below exist (SUPABASE.md, step 8). Status: written, untested (no Supabase project yet).
--
-- Needs the pg_cron and pg_net extensions (Database → Extensions in the dashboard).
-- Vault secrets (created by Ole in the SQL editor, values never in the repo):
--   matkassa_project_url   e.g. https://<project-ref>.supabase.co
--   matkassa_cron_secret   a long random string; the same value is set as CRON_SECRET for the Edge Function

select cron.unschedule('matkassa-weekly-pull') where exists (select 1 from cron.job where jobname = 'matkassa-weekly-pull');

select cron.schedule(
  'matkassa-weekly-pull',
  '0 18 * * 0',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'matkassa_project_url') || '/functions/v1/fetch-receipts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'matkassa_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
