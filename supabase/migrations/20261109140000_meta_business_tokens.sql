-- The Business Managers Kaizen works through, and the Meta token for each. Kaizen is the default (its system user's
-- token is META_SYSTEM_USER_TOKEN in Vercel, never stored here); ZenChange, Get Me Friends and Blue Cherry Group are
-- white-label partner agencies whose clients' ad accounts live in their own Business Managers. Each one gives Kaizen's
-- app access, a system user is made there with the ad accounts and the app, and an exec pastes its token in Settings.
-- Each client picks its Business Manager in Team & setup (clients.meta_business, null = Kaizen), and every Graph call
-- for that client's ad accounts, reads and changes, goes through that Business Manager's token.
--
-- The token is encrypted by the app (AES-256-GCM, key in TOKEN_ENCRYPTION_KEY): iv, auth tag and ciphertext, base64.
-- Never readable from the browser: RLS is on with no policies, so only the server (service role) reads or writes these
-- tables. Everyone sees names and status through server actions.

create table if not exists public.meta_business_tokens (
  id               uuid primary key default gen_random_uuid(),
  -- Kaizen's name for it (Kaizen, ZenChange, Get Me Friends, Blue Cherry Group)
  name             text not null,
  -- Kaizen's own: uses META_SYSTEM_USER_TOKEN, never a stored token
  is_default       boolean not null default false,
  sort             int not null default 0,
  -- Meta's Business Manager, filled from the token when it's connected
  business_id      text,
  business_name    text,
  token_iv         text,
  token_tag        text,
  token_ciphertext text,
  token_last4      text,
  scopes           text[] not null default '{}',
  expires_at       timestamptz,
  app_id           text,
  system_user_id   text,
  system_user_name text,
  connected_by     uuid references public.profiles (id) on delete set null,
  connected_at     timestamptz,
  created_at       timestamptz not null default now(),
  last_checked_at  timestamptz,
  last_error       text,
  -- The partnership ended: off every list and picker, its clients back on Kaizen, kept for the record
  archived_at      timestamptz,
  status           text not null default 'not_connected' check (status in ('not_connected', 'active', 'invalid', 'revoked')),
  -- A connected partner Business Manager holds its encrypted token; Kaizen's never does
  constraint meta_business_tokens_cipher check (
    (is_default and token_ciphertext is null)
    or (not is_default and (status in ('not_connected', 'revoked') or (token_iv is not null and token_tag is not null and token_ciphertext is not null)))
  )
);
create unique index if not exists meta_business_tokens_name on public.meta_business_tokens (lower(name)) where archived_at is null;
create unique index if not exists meta_business_tokens_one_default on public.meta_business_tokens (is_default) where is_default;
-- One Kaizen Ads row per Meta Business Manager: the same token can't be connected under two names
create unique index if not exists meta_business_tokens_business on public.meta_business_tokens (business_id) where business_id is not null and status <> 'revoked';

insert into public.meta_business_tokens (name, is_default, sort, status) values
  ('Kaizen', true, 0, 'active'),
  ('ZenChange', false, 1, 'not_connected'),
  ('Get Me Friends', false, 2, 'not_connected'),
  ('Blue Cherry Group', false, 3, 'not_connected')
on conflict do nothing;

-- Which ad accounts each Business Manager's token reaches, refreshed on connect and by the daily check. can_manage:
-- the system user may change the account (Manage campaigns or full control), not only read it.
create table if not exists public.meta_business_token_accounts (
  business_token_id uuid not null references public.meta_business_tokens (id) on delete cascade,
  ad_account_id     text not null,
  account_name      text,
  can_manage        boolean not null default false,
  checked_at        timestamptz not null default now(),
  primary key (business_token_id, ad_account_id)
);
create index if not exists meta_business_token_accounts_account on public.meta_business_token_accounts (ad_account_id);

alter table public.meta_business_tokens enable row level security;
alter table public.meta_business_token_accounts enable row level security;
revoke all on public.meta_business_tokens from anon, authenticated;
revoke all on public.meta_business_token_accounts from anon, authenticated;

-- Each client's Business Manager: null is Kaizen's (the default). Read like every other client column; set by execs.
alter table public.clients add column if not exists meta_business uuid references public.meta_business_tokens (id) on delete set null;
create index if not exists clients_meta_business on public.clients (meta_business) where meta_business is not null;
comment on column public.clients.meta_business is 'The Business Manager whose Meta token reads and changes this client''s ad accounts (meta_business_tokens); null: Kaizen''s own';
