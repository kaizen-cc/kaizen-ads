-- The email account's change history (Nov 2026): is anyone actually working in the account?
--
-- Klaviyo has no public audit log, so the closest honest signal is read on every Klaviyo sync: each campaign, flow,
-- flow step, template, list, segment and form carries when it was created and last updated and its status, and
-- comparing one read with the last says what happened in between (a campaign created, edited, scheduled or sent, a
-- flow switched live, an email in a flow edited, a list or segment made, a form published). Several edits between two
-- reads show as one, at the latest time, and the API never says who made them. See src/lib/email-ops/changes-core.ts.
--
-- Shown on the Email KPI board's account sheet ("Last change 5h ago · Flow "Welcome" set live" and the Change history
-- list), and read by the email sprint's checks (were the planned moves made?), the email audit and the email chat.
-- Readable by staff who can see the client (the same rule as the other email tables); written only by the server.
-- Nothing is ever deleted from it by the app. Additive and idempotent: safe to run more than once.

create table if not exists public.email_account_changes (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  provider     text not null default 'klaviyo',
  object_type  text not null check (object_type in ('campaign', 'flow', 'flow_step', 'template', 'list', 'segment', 'form')),
  object_id    text not null,
  object_name  text not null,
  kind         text not null check (kind in ('created', 'edited', 'scheduled', 'sent', 'status', 'published', 'removed')),
  detail       text,                                   -- "draft to live", or the day a campaign is scheduled for
  parent_name  text,                                   -- a flow step's flow
  step_kind    text,                                   -- a flow step's kind (send_email, send_sms, time_delay...)
  manual       boolean not null default true,          -- false for what happens by itself (a scheduled send going out)
  happened_at  timestamptz not null,                   -- the provider's own time for it (the latest edit when several)
  seen_at      timestamptz not null default now(),     -- when the sync noticed it
  dedupe_key   text not null
);
create unique index if not exists email_account_changes_dedupe on public.email_account_changes (client_id, dedupe_key);
create index if not exists email_account_changes_client on public.email_account_changes (client_id, happened_at desc);

alter table public.email_account_changes enable row level security;
drop policy if exists "staff read email account changes" on public.email_account_changes;
create policy "staff read email account changes" on public.email_account_changes for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

comment on table public.email_account_changes is 'What changed in a client''s email account (Klaviyo), worked out from created and updated times and statuses on each sync; who made a change is not known';
