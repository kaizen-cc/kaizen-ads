-- Archiving prospects (owner, Nov 24 2026): a prospect is never deleted. Archive asks why (not a fit, no budget, went
-- with someone else, no response, duplicate, not a real business, other + a note) and records who and when; the
-- prospect leaves the pipeline (its stage is kept, so Unarchive puts it back where it was), and its upcoming call
-- briefs stop (status "stopped": no brief, no item, no bell). A sales call booked later still gets a brief, flagged
-- "previously archived". "Lost" stays a separate pipeline outcome.

alter table public.prospects add column if not exists archived_at timestamptz;
alter table public.prospects add column if not exists archived_by uuid references public.profiles (id) on delete set null;
alter table public.prospects add column if not exists archive_reason text check (archive_reason in ('not_a_fit', 'no_budget', 'went_elsewhere', 'no_response', 'duplicate', 'not_real', 'other'));
alter table public.prospects add column if not exists archive_note text;
create index if not exists prospects_archived on public.prospects (archived_at desc) where archived_at is not null;

alter table public.sales_call_briefs drop constraint if exists sales_call_briefs_status_check;
alter table public.sales_call_briefs add constraint sales_call_briefs_status_check check (status in ('pending', 'ready', 'cancelled', 'done', 'failed', 'stopped'));
