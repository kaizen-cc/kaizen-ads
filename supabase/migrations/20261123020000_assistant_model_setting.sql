-- The assistant's brain in Settings > AI agents: the model and effort every assistant answer runs on (the personal
-- assistant and any agent on a call or in the assistant's chat). It was fixed in the code at Sonnet, low effort; the
-- owner asked for Sonnet at medium effort, and an exec can change it here. Until this runs, the code uses the same
-- default. Its calls are still logged under the Coach, as before.
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources)
select 'assistant_talk', 'Assistant', 'Your personal assistant and every agent you call or chat with through it: each answer on a call and in the assistant''s chat runs on this model and effort.', 'sonnet', 'medium', true, 98, 'spark', '{}'::jsonb
 where not exists (select 1 from public.ai_agents a where a.key = 'assistant_talk');
