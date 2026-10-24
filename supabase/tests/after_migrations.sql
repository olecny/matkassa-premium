-- Supabase gives service_role full table rights by default; mirror that after the migrations ran.
grant all on all tables in schema public to service_role;
