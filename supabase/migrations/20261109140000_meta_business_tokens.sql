-- A Meta access token per client Business Manager. Some client ad accounts live in the client's own Business Manager,
-- where Kaizen's system user can't be given access through a partner share. The client's business gives Kaizen's app
-- partner access, a system user is made there with the ad accounts and the app, and its token is pasted into Kaizen Ads.
-- Every Graph call aimed at an account that token reaches uses it; everything else keeps Kaizen's own token.
--
-- The token is encrypted by the app (AES-256-GCM, key in TOKEN_ENCRYPTION_KEY): iv, auth tag and ciphertext, base64.
-- Never readable from the browser: RLS is on with no policies, so only the server (service role) reads or writes these
-- tables. Execs see the metadata through server actions.

create table if not exists public.meta_business_tokens (
  id               uuid primary key default gen_random_uuid(),
  business_id      text,
  business_name    text,
  label            text,
  token_iv         text,
  token_tag        text,
  token_ciphertext text,
  token_last4      text,
  scopes           text[] not null default '{}',
  expires_at       timestamptz,
  app_id           text,
  system_user_id   text,
  system_user_name text,
  client_id        uuid references public.clients (id) on delete set null,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  last_checked_at  timestamptz,
  last_error       text,
  status           text not null default 'active' check (status in ('active', 'invalid', 'revoked')),
  -- A revoked token keeps its row (who, when, which business) but never its ciphertext
  constraint meta_business_tokens_cipher check (status = 'revoked' or (token_iv is not null and token_tag is not null and token_ciphertext is not null))
);
create index if not exists meta_business_tokens_status on public.meta_business_tokens (status);
create index if not exists meta_business_tokens_client on public.meta_business_tokens (client_id);
-- One live token per business: a new one for the same business replaces the old
create unique index if not exists meta_business_tokens_one_live on public.meta_business_tokens (business_id) where status <> 'revoked' and business_id is not null;

-- Which ad accounts each token reaches, refreshed on save and by the daily check. can_manage: the system user may
-- change the account (Manage campaigns or full control), not only read it.
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
