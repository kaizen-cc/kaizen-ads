-- Copy documents also hold paid ad concept briefs (creative) and organic posts (social): the deliverable flow's creative
-- and social lines write them the way email writes campaigns, so the document view, comments, approval and Drive Doc
-- are the same. The flow's own runs already take any line key (deliverable_runs.line is free text).
alter table public.copy_docs drop constraint if exists copy_docs_kind_check;
alter table public.copy_docs add constraint copy_docs_kind_check check (kind in ('campaign', 'flow', 'sms', 'creative', 'social'));
