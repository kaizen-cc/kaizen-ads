-- The Google Ads Buyer: the Google counterpart of the Media Buyer, with its own skills (an account audit that also
-- follows the sprint, and a launcher for later). Its core and the skills' instructions start empty, to be written in
-- Settings; the code gives each call its Google-specific frame.
insert into public.ai_roles (key, label, description, icon, sort_order, core) values
  ('google_buyer', 'Google Ads Buyer', 'The Google side of media buying: audits Google Ads accounts against their KPI, follows the optimization sprint every day, and (later) launches.', 'target', 5, '')
on conflict (key) do nothing;
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions) values
  ('google_auditor', 'Google account audit', 'Audits a Google Ads account against its KPI target (campaigns, bidding, budgets, impression share, keywords and search terms, conversion tracking), writes the plan, and checks the sprint every day.', 'opus', 'high', true, 60, '{}', 'google_buyer', ''),
  ('google_launcher', 'Google launcher', 'Will push approved ads to Google Ads, paused, for the buyer to confirm. Not wired in yet.', 'opus', 'high', false, 61, '{}', 'google_buyer', '')
on conflict (key) do nothing;
update public.ai_roles set sort_order = sort_order + 1 where sort_order >= 5 and key <> 'google_buyer';
