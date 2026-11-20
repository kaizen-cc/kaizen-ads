-- Social connections start from a Business Manager (owner, Nov 20 2026), the way a client's Meta ad account does: the
-- team picks the Business Manager, then picks from that Business Manager's own Pages and the Instagram accounts on them.
-- Each linked account remembers the Business Manager it came through (null: Kaizen's own, or found before this), so the
-- Social connections card can say where it came from and the sync reads the Page with that Business Manager's token.

alter table public.social_links add column if not exists business_token_id uuid references public.meta_business_tokens(id) on delete set null;
comment on column public.social_links.business_token_id is 'The Business Manager this account was linked through (meta_business_tokens); null: Kaizen''s own, or linked before Business Managers were picked';
