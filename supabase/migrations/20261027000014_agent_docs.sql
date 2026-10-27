-- Training an agent with material: execs share files (PDF, Word, PowerPoint, Excel, text, pictures) and links in the
-- agent and skill chats on Settings. Files live in the private agent-docs bucket under the agent's or skill's key; the
-- chat reads them and proposes edits to the playbook. Each message keeps what was shared with it.

insert into storage.buckets (id, name, public, file_size_limit) values ('agent-docs', 'agent-docs', false, 52428800) on conflict (id) do nothing;

drop policy if exists "execs add agent docs" on storage.objects;
create policy "execs add agent docs" on storage.objects for insert to authenticated with check (bucket_id = 'agent-docs' and private.is_exec());
drop policy if exists "execs read agent docs" on storage.objects;
create policy "execs read agent docs" on storage.objects for select to authenticated using (bucket_id = 'agent-docs' and private.is_exec());

alter table public.ai_role_chats add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.ai_agent_chats add column if not exists attachments jsonb not null default '[]'::jsonb;
