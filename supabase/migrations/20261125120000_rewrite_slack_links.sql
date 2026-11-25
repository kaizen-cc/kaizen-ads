-- Slack links that open the app at the message on a phone (the owner, Nov 25 2026): every saved bare
-- https://slack.com/archives/… link given the workspace's own address (https://<workspace>.slack.com/archives/…).
-- Called by the Slack step with the address Slack itself reports (src/lib/context/slack.ts fixStoredSlackLinks);
-- idempotent, only bare links change. Returns how many rows changed.
create or replace function public.rewrite_slack_links(p_base text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  k integer;
  to_ text;
begin
  if p_base !~ '^https://[a-z0-9][a-z0-9-]*\.slack\.com/$' or p_base = 'https://app.slack.com/' then
    raise exception 'not a Slack workspace address: %', p_base;
  end if;
  to_ := p_base || 'archives/';
  update context_items set url = replace(url, 'https://slack.com/archives/', to_) where url like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update owed_replies set url = replace(url, 'https://slack.com/archives/', to_) where url like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update message_promises set url = replace(url, 'https://slack.com/archives/', to_) where url like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update notifications set href = replace(href, 'https://slack.com/archives/', to_) where href like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update done_checks set link = replace(link, 'https://slack.com/archives/', to_) where link like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update assistant_heads_ups set href = replace(href, 'https://slack.com/archives/', to_) where href like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update assistant_heads_up_items set href = replace(href, 'https://slack.com/archives/', to_) where href like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update hidden_items set href = replace(href, 'https://slack.com/archives/', to_) where href like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update ladder_nudges set href = replace(href, 'https://slack.com/archives/', to_) where href like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update client_direction_changes set url = replace(url, 'https://slack.com/archives/', to_) where url like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update line_reviews set permalink = replace(permalink, 'https://slack.com/archives/', to_) where permalink like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  update email_suggestions set source_url = replace(source_url, 'https://slack.com/archives/', to_) where source_url like 'https://slack.com/archives/%'; get diagnostics k = row_count; n := n + k;
  return n;
end;
$$;
revoke all on function public.rewrite_slack_links(text) from public, anon, authenticated;
grant execute on function public.rewrite_slack_links(text) to service_role;
