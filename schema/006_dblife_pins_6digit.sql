-- =====================================================================
-- dblife / Brown Life — migrate PINs from 4-digit to 6-digit (migration 006)
--
-- John standardised on 6-digit PINs across all his apps (2026-06-07):
--   D (id 'john')  1111 -> 111111
--   K (id 'lisa')  2222 -> 222222
--
-- dblife_auth_users is authoritative (it overlays the env fallback), so we
-- upsert both rows with fresh scrypt hashes of the 6-digit PINs. This also
-- overwrites D's existing 4-digit row. The matching 6-digit hashes are mirrored
-- into _lib/auth.js (DEFAULT_HASH_JOHN/LISA) so the env fallback agrees if the
-- DB is ever unreachable. Salts differ per copy — both verify the same PIN.
-- Idempotent.
-- =====================================================================

insert into dblife_auth_users (id, name, pin_hash, updated_at) values
  ('john', 'D', 'scrypt$15a6da5d7c1aee4eafe6dce3dec5e99e$ea491356ebfa43d0f0990296117c5f45a1724117658970b6c722cb30499985ac', now()),
  ('lisa', 'K', 'scrypt$95f54acacb727e93b53cca13369be890$e1dc3d15bf847e6d400051d90d84d5d3270b7d28a7000289f1de0e2c6ca8aff0', now())
on conflict (id) do update
  set pin_hash = excluded.pin_hash,
      updated_at = excluded.updated_at;
