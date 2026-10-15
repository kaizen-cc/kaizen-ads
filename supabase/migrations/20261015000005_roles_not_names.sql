-- Kaizen Ads — agents speak in roles and Kaizen standards, never people's names
-- (applied 2026-10-15; replaces are no-ops on a database that's already clean)

update public.ai_agents set instructions = replace(replace(instructions,
  'humans decide (Jesus, Head of Creative, can override anything).', 'humans decide (the Head of Creative can override anything).'),
  'Camille and the copy agent do that.', 'the Copywriter agent and Kaizen''s copy reviewer do that.')
where key = 'suggest';

update public.ai_agents set
  description = 'Writes Kaizen''s copy set for each angle: 3 short-form and 2 long-form ads, each with primary text, headline, link description and CTA button. Runs as soon as the creative is approved.',
  live = true,
  instructions = replace(replace(replace(instructions,
    'Your copy goes straight to Camille (copywriter), who edits everything before the client sees it. Her edits and the client''s approved copy are the best signal of what good looks like for this client: when they disagree with a generic rule here, follow them.',
    'Your copy goes straight to Kaizen''s copy review, where every set is edited before the client sees it. Those edits and the client''s approved copy are the best signal of what good looks like for this client: when they disagree with a generic rule here, follow them.'),
    'The set (Kyle''s format, always all five):', 'The set (Kaizen''s copy standard, always all five):'),
    'Camille sees a character count on every field and sends back anything over.', 'Copy review sees a character count on every field and sends back anything over.')
where key = 'copy';

update public.ai_agents set
  description = 'Turns an approved ad into campaign, ad set and ad names and settings, then pushes it to Meta paused for the buyer to check. Follows Kaizen''s media-buying standards.',
  instructions = replace(instructions, 'Kyle owns this agent''s media-buying logic. Until his playbook is added as skills here, follow these defaults:', 'Follow Kaizen''s media-buying standards. Until the full launch playbook is added as skills here, follow these defaults:')
where key = 'launcher';

update public.ai_agents set instructions = replace(instructions, 'Nothing is ever auto-approved: Jesus (Head of Creative) reviews it, then the client approves.', 'Nothing is ever auto-approved: the Head of Creative reviews it, then the client approves.')
where key = 'brandbible';

update public.ai_knowledge set body = replace(body, 'written by the copy agent and Camille.', 'written by the Copywriter agent and edited in Kaizen''s copy review.')
where title = 'Formats, sizes and creative standards';

update public.ai_knowledge set body = replace(body, 'apartments like The Rowan', 'apartment communities')
where title = 'Meta ad policy guardrails';

update public.ai_knowledge set body = replace(replace(body,
  'Team: media buyers own each account''s performance and set its KPI target and budget (from internal strategy or from the client). Graphic designers make images and carousels (Nelson is the main graphic designer); video editors make videos (Jazem is the main video editor). Jesus is Head of Creative and approves creative internally. Camille reviews all copy. Jorgi handles client follow-up and approvals. Dipesh is Head of Meta. Executives: Ryan (CMO), Kyle, Santi.',
  'Team: media buyers own each account''s performance and set its KPI target and budget (from internal strategy or from the client). Graphic designers make images and carousels; video editors make videos. The Head of Creative approves creative internally. The copywriter reviews all copy. Customer success handles client follow-up and approvals. The Head of Meta leads the media buyers; executives oversee everything.'),
  'Camille reviews every set with a character count on each field.', 'Copy review checks every set with a character count on each field.')
where title = 'How Kaizen works' and agent_key is null;

update public.ai_knowledge set
  title = 'Naming convention (starting point)',
  body = replace(body, 'Placeholder until Kyle adds the real convention:', 'Starting point until Kaizen''s full naming convention is added:')
where title = 'Naming convention (placeholder for Kyle)';

update public.ai_knowledge set body = replace(body,
  'and the Kaizen team (Jesus, Head of Creative; Nelson, main graphic designer; Jazem, main video editor; Camille, copy; Jorgi, client follow-up; the media buyer); approval flow (Jesus reviews, then the client approves; never auto-approved)',
  'and the Kaizen team by role (Head of Creative, graphic designer, video editor, copywriter, customer success, media buyer); approval flow (the Head of Creative reviews, then the client approves; never auto-approved)')
where title = 'Brand Bible structure, section by section';
