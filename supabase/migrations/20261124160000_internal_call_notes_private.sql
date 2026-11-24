-- An internal meeting's raw notes are for execs and leads only (owner, Nov 24 2026): what management says about people
-- on the team must never be readable by that person or the team. A teammate on a client still sees the client's part
-- of the call (call_mentions, its summary with management talk taken out: src/lib/people-matters.ts), never the notes.
drop policy if exists "staff read calls" on public.client_calls;
create policy "staff read calls" on public.client_calls for select to authenticated using (
  (select private.is_exec_or_lead())
  or (
    status is distinct from 'internal'
    and (
      ((client_id is not null) and ((select private.staff_sees_all()) or coalesce((client_id = any ((select private.staff_client_ids())::uuid[])), false)))
      or exists (select 1 from call_mentions m where m.call_id = client_calls.id and ((select private.staff_sees_all()) or coalesce((m.client_id = any ((select private.staff_client_ids())::uuid[])), false)))
    )
  )
);
