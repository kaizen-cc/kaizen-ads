-- Looms about email marketing (Klaviyo and similar) and organic social now feed the email and social agents.
-- 1) A Loom's platform can be email or social, not only an ad platform.
-- 2) What the Loom intake files to an email or social agent waits for approval: the agent reads only approved
--    knowledge. Everything already in the library is approved, so nothing changes for the buying agents or clients.

alter table public.loom_videos drop constraint if exists loom_videos_platform_check;
alter table public.loom_videos add constraint loom_videos_platform_check check (platform in ('meta', 'google', 'both', 'email', 'social', 'none'));

alter table public.knowledge_docs add column if not exists review text not null default 'approved' check (review in ('approved', 'pending'));
alter table public.knowledge_docs add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.knowledge_docs add column if not exists reviewed_at timestamptz;
create index if not exists knowledge_docs_pending on public.knowledge_docs (agent_key) where review = 'pending' and removed_at is null;
