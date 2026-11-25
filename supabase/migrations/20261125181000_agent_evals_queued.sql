-- Agent tests can wait in a queue (a model or effort change weighed for cost, docs/API-COST.md): the evals step runs them
alter table public.agent_evals drop constraint if exists agent_evals_status_check;
alter table public.agent_evals add constraint agent_evals_status_check check (status = any (array['queued', 'running', 'done', 'failed']));
