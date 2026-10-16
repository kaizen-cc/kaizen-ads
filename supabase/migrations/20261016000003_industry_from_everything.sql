-- Which method set a client's industry: 1 = the first, thin read (name, a snippet of notes); 2 = everything the
-- client page knows (intake, Brand Bible, briefing, Slack and email, the website, the ads). Older ones are redone.
alter table public.clients add column industry_version int not null default 1;
update public.clients set industry_version = 2 where industry_source = 'team';

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('industry', 'Industry reader', 'Reads everything known about a client (intake form, Brand Bible, briefing, Slack and email, the website, their ads) and sorts them into an industry, so winning ads are matched to similar clients.', 'sonnet', 'low', true, 13, 'eye', '{}')
on conflict (key) do nothing;
