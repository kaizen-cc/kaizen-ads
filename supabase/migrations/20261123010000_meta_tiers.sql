-- Meta Ads tiers (owner, Nov 20 2026): what the ads team does for the client on Meta, by whether they're with our
-- social team. Performance: conversions only (leads, purchases), no social with us. Social Boost: boosting the social
-- team's posts for reach and engagement. Performance + Boost: conversions are the bulk, with a steady boost line so the
-- social side isn't left behind. A Performance client is never flagged for having nothing boosted.
insert into public.service_tiers (service, label, includes, sort_order)
select v.service, v.label, v.includes, v.sort_order
from (values
  ('facebook-ads', 'Performance', 'Conversions: leads and purchases. Not on social with us', 1),
  ('facebook-ads', 'Social Boost', 'Boosting the social team''s posts for reach and engagement', 2),
  ('facebook-ads', 'Performance + Boost', 'Conversions are the bulk, plus a steady boost line for the social team''s posts', 3)
) as v(service, label, includes, sort_order)
where not exists (select 1 from public.service_tiers t where t.service = v.service and t.label = v.label);
