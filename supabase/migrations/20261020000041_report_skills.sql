-- Client reporting skills on the existing buyer agents (no new agents): the weekly and monthly write-up in the buyer's
-- voice (Meta and Google), and a QA pass that checks every number and claim before a buyer sees it. Instructions start
-- empty, to be tuned in Settings; the code gives each call its frame.
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions) values
  ('reporter', 'Client reports', 'Drafts the weekly and monthly client report for a Meta account in the buyer''s own voice: what we did, what we''re doing and why, what''s next, with the numbers and the ads that worked. Learns each client''s preferences from the buyer''s edits.', 'opus', 'medium', true, 45, '{}', 'media_buyer', ''),
  ('google_reporter', 'Google client reports', 'Drafts the weekly and monthly client report for a Google Ads account in the buyer''s own voice, the same way as the Meta one.', 'opus', 'medium', true, 62, '{}', 'google_buyer', ''),
  ('report_qa', 'Report QA', 'Checks every report before the buyer sees it: each number against the data, claims against the work log, the math, and anything alarming the buyer should look at before it goes to the client.', 'opus', 'high', true, 46, '{}', 'media_buyer', '')
on conflict (key) do nothing;
