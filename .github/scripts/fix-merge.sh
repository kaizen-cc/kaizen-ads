#!/usr/bin/env bash
# Merges a fix that passed every check: one squash commit on the latest main as kaizen-cc (the only identity Vercel
# deploys). A database change in it is applied to the live database first (each migration in one transaction, recorded
# in Supabase's migration history), so the code and the database go live together; if a migration fails, nothing
# merges and the reason is commented. Needs ISSUE, PR, HOW ("auto", "owner" or "approved"), GH_TOKEN, SUPABASE_DB_URL.
set -euo pipefail
BRANCH="claude/fix-$ISSUE"
git fetch origin main "$BRANCH"
git checkout -B main origin/main
if ! git merge --squash "origin/$BRANCH"; then
  git reset --hard origin/main
  gh pr comment "$PR" --body "A check failed: the fix no longer applies cleanly on main even after rebasing. It needs another try."
  exit 1
fi
MIGRATIONS=$(git diff --cached --name-only --diff-filter=A -- 'supabase/migrations/*.sql' | sort || true)
for f in $MIGRATIONS; do
  echo "Applying $f"
  if ! psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -q -f "$f" > /tmp/migration.log 2>&1; then
    git reset --hard origin/main
    gh pr comment "$PR" --body "A check failed: the database change $f didn't apply, so nothing was merged. $(tail -n 5 /tmp/migration.log | tr '\n' ' ' | cut -c1-600)"
    exit 1
  fi
  base=$(basename "$f" .sql)
  version="${base%%_*}"
  name="${base#*_}"
  psql "$SUPABASE_DB_URL" -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name') on conflict do nothing" > /dev/null 2>&1 || true
done
TITLE=$(gh pr view "$PR" --json title --jq .title)
case "$HOW" in
  owner) WHY="approved by the owner in Kaizen OS when the ticket was approved, and merged after every check passed" ;;
  approved) WHY="approved by the owner in Kaizen OS and merged after every check passed" ;;
  *) WHY="merged automatically after every check passed" ;;
esac
git commit -m "$TITLE" -m "Fix by Claude from #$ISSUE, $WHY."
# Someone pushed in between: take their commits and try again (twice)
for attempt in 1 2 3; do
  if git push origin main; then break; fi
  [ "$attempt" = 3 ] && { gh pr comment "$PR" --body "A check failed: main kept moving and the merge couldn't be pushed. It needs another try."; exit 1; }
  git fetch origin main
  git rebase origin/main
done
SHA=$(git rev-parse --short HEAD)
NOTE=""
[ -n "$MIGRATIONS" ] && NOTE=" Its database change was applied: $(echo $MIGRATIONS | tr '\n' ' ')."
gh pr close "$PR" --delete-branch --comment "Merged into main as $SHA (every check passed).$NOTE"
gh issue close "$ISSUE" --comment "Every check passed: merged into main as $SHA. It goes live with this Vercel deploy.$NOTE"
