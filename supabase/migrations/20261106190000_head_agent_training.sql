-- The heads of each service line train their own line's AI agent (who may is decided in src/lib/agent-access.ts:
-- canTrainAgent). Their edits go through the server with that check, so the exec-only policies on the playbook tables
-- stay as they are. Every change keeps what it replaced and what it wrote, so an exec can see the before and after
-- and put it back in one click; a head's changes are marked for the execs' quiet daily digest.

alter table public.agent_changes add column if not exists record text;         -- what it changed: agent:<key>, item:<id> or role:<key>
alter table public.agent_changes add column if not exists before jsonb;        -- the record before (null: it didn't exist)
alter table public.agent_changes add column if not exists after jsonb;         -- the record after
alter table public.agent_changes add column if not exists changed_as text;     -- the person's role at the time (head_of_google, ...)
alter table public.agent_changes add column if not exists by_head boolean not null default false;
alter table public.agent_changes add column if not exists summary text;        -- "Head of Google updated the Google Ads Buyer's ..."
alter table public.agent_changes add column if not exists reverted_at timestamptz;
alter table public.agent_changes add column if not exists reverted_by uuid references public.profiles(id) on delete set null;

create index if not exists agent_changes_by_head on public.agent_changes (changed_at desc) where by_head;
