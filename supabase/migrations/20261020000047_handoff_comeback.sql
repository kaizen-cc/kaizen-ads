-- A client going live again: the buyer gets a comeback brief (where we left the account, what changed while we
-- were away, how to pick it back up) on the same page and chat as a handoff. kind tells them apart.
alter table public.account_handoffs add column if not exists kind text not null default 'handoff';
alter table public.account_handoffs drop constraint if exists account_handoffs_kind_check;
alter table public.account_handoffs add constraint account_handoffs_kind_check check (kind in ('handoff', 'comeback'));
alter table public.account_handoffs drop constraint if exists account_handoffs_via_check;
alter table public.account_handoffs add constraint account_handoffs_via_check check (via in ('app', 'sheet', 'form', 'reactivated'));
-- private.notify_handoff: a comeback's notification reads "<client> is back: how to pick it up" (applied via MCP)
