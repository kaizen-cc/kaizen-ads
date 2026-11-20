-- Promises on the person's Today card come with a drafted message (owner, Nov 20 2026): an update on something they
-- said yes to in Slack or email, written in the same thread; and an update to the client on something promised on a
-- call. Kept until the conversation moves on (draft_basis), like owed replies' drafts.
alter table public.message_promises add column if not exists draft text, add column if not exists draft_basis text, add column if not exists drafted_at timestamptz;
alter table public.call_commitments add column if not exists draft text, add column if not exists drafted_at timestamptz;
