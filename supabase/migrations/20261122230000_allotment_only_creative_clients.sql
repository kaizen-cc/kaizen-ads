-- Only clients we do creative for (owner, Nov 19 2026): Creative is on the client's services (Kaizen Track's or added
-- on the client page), not removed there, and not strategy only. The allotment view counts only them; a client whose
-- creative was removed holds no creative package; drafted briefs for the rest are put away (expired, not declined).
do $$
declare d text;
begin
  d := pg_get_viewdef('public.client_allotment_usage'::regclass, true);
  if position('services_removed' in d) = 0 then
    d := replace(d, 'WHERE c.creative_package AND', 'WHERE c.creative_package AND ''creative''::text = ANY (COALESCE(c.services, ''{}''::text[]) || COALESCE(c.services_extra, ''{}''::text[])) AND NOT ''creative''::text = ANY (COALESCE(c.services_removed, ''{}''::text[])) AND NOT ''creative''::text = ANY (COALESCE(c.strategy_only, ''{}''::text[])) AND');
    execute 'create or replace view public.client_allotment_usage with (security_invoker = on) as ' || rtrim(d, ';');
  end if;
end $$;

update public.clients set creative_package = false
where creative_package and ('creative' = any(coalesce(services_removed,'{}')) or not ('creative' = any(coalesce(services,'{}') || coalesce(services_extra,'{}'))));

update public.creative_suggestions s set status = 'expired', updated_at = now()
from public.clients c
where c.id = s.client_id and s.status = 'open'
  and ('creative' = any(coalesce(c.services_removed,'{}')) or not ('creative' = any(coalesce(c.services,'{}') || coalesce(c.services_extra,'{}'))) or 'creative' = any(coalesce(c.strategy_only,'{}')));
