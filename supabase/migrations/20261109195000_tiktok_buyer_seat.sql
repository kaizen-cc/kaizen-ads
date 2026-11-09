-- A TikTok buyer seat on each client, like the Meta and Google buyer seats (primary plus secondaries). On its own, in
-- its own migration: a new enum value can't be used in the same transaction that adds it. Additive and idempotent.
alter type public.assignment_role add value if not exists 'tiktok_buyer';
