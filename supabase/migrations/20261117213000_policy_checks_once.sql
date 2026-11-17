-- Policy checks about the person (is staff, is an exec, their profile or contact id, sees every client) asked once per
-- query instead of once per row (Nov 2026).
--
-- A bare private.is_staff() in a policy runs for every row it filters: on the 18,000 account changes the KPI board
-- reads that was 2.7 s, against 12 ms once wrapped in (select ...), which Postgres runs once and reuses. Nothing about
-- who sees what changes: these functions only read who's asking, never the row.
--
-- New policies: always write (select private.is_staff()), (select private.current_profile_id()) and so on.

do $$
declare
  p record;
  q text;
  c text;
  sql text;
  bare constant text := '(?<!SELECT )private\.(is_staff|is_exec|is_exec_or_lead|current_profile_id|current_contact_id|sees_all_clients)\(\)';
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname in ('public', 'storage')
       and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ bare
  loop
    q := regexp_replace(p.qual, bare, '(SELECT private.\1())', 'g');
    c := regexp_replace(p.with_check, bare, '(SELECT private.\1())', 'g');
    sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if q is not null then sql := sql || ' using (' || q || ')'; end if;
    if c is not null then sql := sql || ' with check (' || c || ')'; end if;
    begin
      execute sql;
    exception when insufficient_privilege then
      raise notice 'left as it was (not ours to change): %.% %', p.schemaname, p.tablename, p.policyname;
    end;
  end loop;
end $$;
