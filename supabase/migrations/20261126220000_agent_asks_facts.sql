-- What an item's sheet shows beyond its words (owner, Nov 25 2026: routine-made items opened to empty sheets):
-- links, the hand-off it stands for, the evidence it's probably done, the choices for the agent's question.
-- src/lib/item-facts.ts. Drafted messages and questions stay in draft.
alter table public.agent_asks add column if not exists facts jsonb;
comment on column public.agent_asks.facts is 'What an item''s sheet shows beyond its words (Nov 25 2026): links [{label,url}], handoff {toId,toName,scope,done,detail}, evidence {state,quote,source,url,at}, options [string] for the agent''s question. Drafted messages and questions stay in draft.';
