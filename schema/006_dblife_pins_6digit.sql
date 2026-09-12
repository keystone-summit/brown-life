-- =====================================================================
-- dblife / Brown Life — migration 006 (NEUTRALISED 2026-09-12)
--
-- Originally applied 2026-06-07: moved both users to 6-digit PINs by
-- UPSERTING fixed scrypt hashes into dblife_auth_users with
-- "on conflict do update". In a PUBLIC repo that was two holes:
--   * the header listed the PINs in plaintext, and
--   * re-running it (it was marked idempotent) would RESET every PIN —
--     including one a user had since changed in the app — back to the
--     published values.
-- The original run's effect is already in the database, so the statement is
-- replaced with a no-op. The PIN values and hashes are gone from HEAD; they
-- remain in git history, which is why both PINs must be changed in the app
-- (Settings -> Change my PIN). Guarded by tests/auth-no-backdoors.test.js:
-- no migration may write a pin_hash.
-- =====================================================================

select 1; -- intentionally does nothing
