-- The email team's three role agents, shipped offline (parked) like the TikTok Ads Buyer: shells for the strategist, the
-- creative and the builder, with skills to write later. Offline, no AI path calls their skills (src/lib/ai.ts checks
-- ai_roles.offline first). An exec brings each online in Settings > AI agents once its core and skills are written.

insert into public.ai_roles (key, label, description, icon, sort_order, core, offline)
select v.key, v.label, v.description, v.icon, v.sort_order, v.core, true
  from (values
    ('email_strategist', 'Email Strategist', 'Email strategy for each client: the send calendar, segmentation, offers, flows coverage, and reading how the client''s Klaviyo account performs. Offline until its core and skills are written.', 'compass', 7,
     'Placeholder: the Email Strategist''s core is written before it goes online.'),
    ('email_creative', 'Email Creative', 'Email design direction and copy on brand: subject lines, preview text, body copy and the layout direction for each email. Offline until its core and skills are written.', 'pen', 8,
     'Placeholder: the Email Creative''s core is written before it goes online.'),
    ('email_builder', 'Email Builder', 'Builds the emails and flows in Klaviyo from approved creative: templates, campaigns as drafts and flows, once writing to Klaviyo is switched on. Offline until then.', 'feed', 9,
     'Placeholder: the Email Builder''s core is written before it goes online.')
  ) as v(key, label, description, icon, sort_order, core)
 where not exists (select 1 from public.ai_roles r where r.key = v.key);

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select v.key, v.label, v.description, v.model, v.effort, false, v.sort_order, '{}'::jsonb, v.role_key, ''
  from (values
    ('email_calendar', 'Email calendar', 'Will plan a client''s send calendar: campaigns by week, offers, and which segment gets what. Offline: a shell to write.', 'opus', 'high', 80, 'email_strategist'),
    ('email_audit', 'Email audit', 'Will audit a client''s email program from Klaviyo: flows coverage, segmentation, deliverability and campaign performance. Offline: a shell to write.', 'opus', 'high', 81, 'email_strategist'),
    ('email_copy', 'Email copy', 'Will write subject lines, preview text and body copy in the client''s voice. Offline: a shell to write.', 'opus', 'medium', 82, 'email_creative'),
    ('email_design_brief', 'Email design brief', 'Will give the layout and design direction for an email, on the client''s brand. Offline: a shell to write.', 'opus', 'medium', 83, 'email_creative'),
    ('email_campaign_build', 'Email campaign build', 'Will build an approved email as a Klaviyo campaign draft, never sent. Offline, and Klaviyo writes stay off.', 'opus', 'high', 84, 'email_builder'),
    ('email_flow_build', 'Email flow build', 'Will build an approved flow in Klaviyo as a draft, for the email team to check. Offline, and Klaviyo writes stay off.', 'opus', 'high', 85, 'email_builder')
  ) as v(key, label, description, model, effort, sort_order, role_key)
 where not exists (select 1 from public.ai_agents a where a.key = v.key);
