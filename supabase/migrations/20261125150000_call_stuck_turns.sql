-- Turns a safety net had to end on a voice call (the words stalled, or the hard cap): the "stuck listening" bug's
-- count per call, so how often it still happens can be seen (Nov 25 2026, src/app/api/agent-call/turn/route.ts).
alter table public.ai_role_calls add column if not exists stuck_turns integer not null default 0;
