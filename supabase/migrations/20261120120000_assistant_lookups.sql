-- The assistant and Kaizen AI search a person's own Kaizen AI chats and imported Claude chats by title and by what
-- was said (search_my_kaizen_ai: ilike on ai_threads.title and ai_messages.content, always filtered to the person's
-- own threads). Trigram indexes keep those "contains" searches fast as the imported history grows. No data changes.

create extension if not exists pg_trgm with schema extensions;

create index if not exists ai_threads_title_trgm on public.ai_threads using gin (title extensions.gin_trgm_ops);
create index if not exists ai_messages_content_trgm on public.ai_messages using gin (content extensions.gin_trgm_ops);
create index if not exists ai_project_docs_name_trgm on public.ai_project_docs using gin (name extensions.gin_trgm_ops);
