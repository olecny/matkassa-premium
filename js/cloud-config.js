// Supabase project for the optional account + sync (see SUPABASE.md).
// Both values are public by design: the anon key can do nothing without a logged-in user, and row-level security
// limits every user to their own rows. NEVER put the service_role key here (or anywhere in this repo).
// Empty = no account features; the app hides "Logg inn" and works fully on this device.
export const CLOUD = {
  url: '', // https://<project-ref>.supabase.co
  anonKey: '', // Project Settings → API → "anon public"
};
