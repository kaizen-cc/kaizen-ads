-- Every brief starts from its quick preview, and the full brief is written only when someone chooses it. Any brief can
-- now be written in the background (from a winner, a tiring ad, a market ad, a pattern, a promise, an idea in words, a
-- conversation, or a suggested brief whose summary someone agreed), and lands as a draft in Ready to send.

alter table public.brief_jobs drop constraint if exists brief_jobs_kind_check;
alter table public.brief_jobs add constraint brief_jobs_kind_check
  check (kind in ('winner', 'refresh', 'market', 'pattern', 'promise', 'idea', 'talk', 'suggestion'));

-- A brief from an idea in words (an audit's creative idea, a conversation, Kaizen AI): its author's own draft
alter table public.creative_suggestions drop constraint if exists creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check
  check (kind = any (array['fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh', 'onboarding', 'call', 'market', 'moment', 'pattern', 'idea']));

-- One open strategist suggestion per client: briefs a person started (a pattern, an idea) never count against it
drop index if exists public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id)
  where status = 'open' and kind not in ('lab', 'winner', 'refresh', 'onboarding', 'call', 'market', 'pattern', 'idea');
