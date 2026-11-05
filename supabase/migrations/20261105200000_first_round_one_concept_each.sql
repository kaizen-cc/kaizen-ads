-- A new client's first round is written as one suggestion per concept from the start (one concept, one brief, one
-- ticket), grouped by a shared batch so the team reviews them together and approves all or some.

alter table public.creative_suggestions add column if not exists batch_id uuid;
alter table public.creative_suggestions add column if not exists batch_label text;
create index if not exists creative_suggestions_batch on public.creative_suggestions (batch_id) where batch_id is not null;

-- A first round is several open suggestions now (one per concept); the writer expires an older round itself
drop index if exists public.creative_suggestions_one_onboarding;

-- One bell per round, not one per concept (the key is the batch)
create or replace function private.notify_first_round() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text; p uuid;
begin
  if new.kind::text = 'onboarding' and new.status::text = 'open' then
    select name into v_client from public.clients where id = new.client_id;
    for p in select * from private.managers() loop
      perform private.notify(p, 'onboarding', format('%s''s first round is ready', v_client), 'Their first concepts are written, one brief each, and waiting for your review.', '/pipeline', new.client_id, format('round:%s', coalesce(new.batch_id, new.id)), 'critical');
    end loop;
  end if;
  return new;
end $$;

-- The strategist's skill, to the rule
update public.ai_knowledge set body = replace(body,
  'Each concept is its own brief, and every version of it counts toward the allotment.',
  'Each concept is its own complete brief from the start (its own title, hook, visual, copy, format, versions and a carousel''s slides) and becomes exactly one ticket; the round is a batch of these briefs the team approves all or some of. Never put two concepts in one brief. Every version counts toward the allotment.')
where agent_key = 'strategist' and title = 'First round for a new client';

-- Open first rounds written before this, with several concepts in one suggestion: one suggestion per concept, in a
-- batch keyed by the old suggestion (so its bell isn't sent again), with the old one expired. Same split as approval
-- used to make: each concept's own format and counts, its name as the title and angle, its hook.
with old as (
  select s.* from public.creative_suggestions s
  where s.kind = 'onboarding' and s.status = 'open' and jsonb_array_length(coalesce(s.draft->'concepts', '[]'::jsonb)) > 1
),
parts as (
  select o.id as old_id, o.client_id, o.signal, o.evidence, o.why, o.created_at, o.draft, c.concept, c.k, jsonb_array_length(o.draft->'concepts') as n
  from old o, jsonb_array_elements(o.draft->'concepts') with ordinality as c(concept, k)
),
drafts as (
  select p.*,
    p.draft
      || jsonb_build_object(
        'title', left(p.concept->>'name', 80),
        'angle', p.concept->>'name',
        'hooks', case when coalesce(p.concept->>'hook', '') = '' then '[]'::jsonb else jsonb_build_array(p.concept->>'hook') end,
        'concepts', jsonb_build_array(p.concept),
        'brief', format('Concept %s of %s in this client''s first round: %s. Make only this concept; the round''s other concepts are their own briefs.', p.k, p.n, p.concept->>'name') || E'\n\n' || coalesce(p.draft->>'brief', ''),
        'formats', jsonb_build_array(
          jsonb_build_object('format', coalesce(p.concept->>'format', p.draft->'formats'->0->>'format', 'image'),
                             'new', case when coalesce((p.concept->>'new')::int, 0) + coalesce((p.concept->>'variations')::int, 0) > 0 then coalesce((p.concept->>'new')::int, 0) else 1 end,
                             'variations', case when coalesce((p.concept->>'new')::int, 0) + coalesce((p.concept->>'variations')::int, 0) > 0 then coalesce((p.concept->>'variations')::int, 0) else 0 end)
          || case when p.concept ? 'cards' and coalesce(p.concept->>'format', '') = 'carousel' then jsonb_build_object('cards', (p.concept->>'cards')::int) else '{}'::jsonb end)
      ) as one
  from parts p
),
made as (
  insert into public.creative_suggestions (client_id, kind, signal, evidence, why, draft, original, created_at, batch_id, batch_label)
  select d.client_id, 'onboarding', d.signal, d.evidence, d.why, d.one, d.one, d.created_at + make_interval(secs => d.k::int), d.old_id, 'First round'
  from drafts d
  order by d.old_id, d.k
  returning id
)
update public.creative_suggestions s set status = 'expired', batch_id = s.id, batch_label = 'First round (split into one brief per concept)', updated_at = now()
where s.id in (select id from old);
