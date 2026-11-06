-- Google audit parity: the "Why?" chat also on a Google idea plan (google_deploys), and lessons from Google audit
-- rebuttals taught to the Google auditor (who may rebut is decided in src/lib/rebut-permission.ts: the permission, or
-- the head of the item's platform).

-- 1. A Why chat thread can sit on a Google idea plan (audit_id is the google_deploys id, item_key 'plan')
alter table public.audit_item_messages drop constraint if exists audit_item_messages_audit_kind_check;
alter table public.audit_item_messages add constraint audit_item_messages_audit_kind_check check (audit_kind in ('account', 'business', 'sprint', 'deploy'));

-- 2. Rebuttals of Google account audits already saved as the Meta auditor's learnings belong to the Google auditor
update public.agent_learnings l
set agent_key = 'google_auditor', updated_at = now()
from public.audit_rebuttals r
join public.account_audits a on a.id = r.audit_id and r.audit_kind = 'account'
join public.kpi_targets t on t.id = a.target_id
where l.source_table = 'audit_rebuttals' and l.source_id = r.id and t.platform = 'google' and l.agent_key = 'auditor';
