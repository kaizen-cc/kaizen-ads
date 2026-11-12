-- Meta ads named in audits and sprint moves carry their ad set (adGroupId) and campaign, so their Ads Manager link
-- selects all three (an ad selected alone is just ticked among every ad in the account). One-off fill for what was
-- written before the links carried parents; safe to run again.
create or replace function private.fill_meta_parents(j jsonb) returns jsonb language plpgsql stable as $$
declare out jsonb; k text; v jsonb; p record;
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'array' then
    select coalesce(jsonb_agg(private.fill_meta_parents(e)), '[]'::jsonb) into out from jsonb_array_elements(j) e;
    return out;
  end if;
  if jsonb_typeof(j) <> 'object' then return j; end if;
  out := '{}'::jsonb;
  for k, v in select * from jsonb_each(j) loop out := out || jsonb_build_object(k, private.fill_meta_parents(v)); end loop;
  if out->>'platform' = 'meta' and out->>'type' = 'ad' and coalesce(out->>'id', '') <> '' and coalesce(out->>'adGroupId', '') = '' then
    select d.adset_id, d.campaign_id into p from public.meta_ad_daily d where d.ad_id = out->>'id' and d.adset_id is not null order by d.date desc limit 1;
    if p.adset_id is not null then
      out := out || jsonb_build_object('adGroupId', p.adset_id::text) || case when coalesce(out->>'campaignId', '') = '' and p.campaign_id is not null then jsonb_build_object('campaignId', p.campaign_id::text) else '{}'::jsonb end;
    end if;
  end if;
  return out;
end $$;

update public.sprint_actions set objects = private.fill_meta_parents(objects) where objects::text like '%"type": "ad"%' and objects::text like '%"platform": "meta"%';
update public.account_audits set result = private.fill_meta_parents(result) where result::text like '%"type": "ad"%' and result::text like '%"platform": "meta"%';
