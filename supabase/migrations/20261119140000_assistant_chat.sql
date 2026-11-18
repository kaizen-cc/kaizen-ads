-- Chat with the assistant, the same conversation as a call.
-- 1. A conversation (ai_role_calls) is a voice call or a typed chat, and can move between them and keep going: `mode`
--    is how it's going now, `mode_log` when it moved ([{mode, at}], the first entry is how it started). Its lines stay
--    in ai_role_chats under the same call_id, so the transcript, notes, learnings and safety review read one thread.
-- 2. How it ended (`end_reason`): the person hung up, the agent ended it on a goodbye, the person closed the chat, or it
--    dropped (a lost connection, a closed tab, no end event). Coming back after a drop says "sorry, we got cut off";
--    after a deliberate end, "hey again".
-- 3. A new way to pick up (`resume_mode` = 'again'): back a few minutes after ending it on purpose.
-- No new policies: people already read their own calls (ai role calls: own read); the server writes them.

alter table public.ai_role_calls
  add column if not exists mode text not null default 'voice',
  add column if not exists mode_log jsonb not null default '[]'::jsonb,
  add column if not exists end_reason text;

do $$ begin
  alter table public.ai_role_calls add constraint ai_role_calls_mode_check check (mode in ('voice', 'text'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ai_role_calls add constraint ai_role_calls_mode_log_small check (jsonb_typeof(mode_log) = 'array' and jsonb_array_length(mode_log) <= 200);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ai_role_calls add constraint ai_role_calls_end_reason_check check (end_reason is null or end_reason in ('hangup', 'goodbye', 'chat_closed', 'dropped'));
exception when duplicate_object then null; end $$;

alter table public.ai_role_calls drop constraint if exists ai_role_calls_resume_mode_check;
alter table public.ai_role_calls add constraint ai_role_calls_resume_mode_check check (resume_mode is null or resume_mode in ('continue', 'again', 'soon', 'later_today', 'fresh'));

-- Finding a person's open chat to pick it up again (a reload, another tab)
create index if not exists ai_role_calls_open_by_person on public.ai_role_calls (profile_id, role_key, started_at desc) where ended_at is null;
