#!/usr/bin/env bash
# Every check a fix must pass before it merges, in order, logged to $1 (default /tmp/checks.log). The failing check's
# name goes to /tmp/checks.failed. The database tests run against the live database (rolled back): when it's briefly
# unreachable (a restart, a timeout), they're tried again a minute later, up to three times, before that counts as a
# failure, so a blip never sends a good fix back.
set -u
LOG="${1:-/tmp/checks.log}"
: > "$LOG"
rm -f /tmp/checks.failed

check() {
  local name="$1"; shift
  echo "::group::$name"
  echo "== $name" >> "$LOG"
  if "$@" >> "$LOG" 2>&1; then
    echo "::endgroup::"
    return 0
  fi
  echo "::endgroup::"
  echo "$name" > /tmp/checks.failed
  tail -n 80 "$LOG"
  return 1
}

check "Lint" npx eslint src tests || exit 1
check "Types" bash -c "npx next typegen && npx tsc --noEmit" || exit 1
check "Logic tests" npm test || exit 1

for attempt in 1 2 3; do
  echo "== Database rules (try $attempt)" >> "$LOG"
  if npm run test:db >> "$LOG" 2>&1; then
    exit 0
  fi
  if tail -n 60 "$LOG" | grep -qiE "ECONNREFUSED|ETIMEDOUT|ECONNRESET|not accepting connections|connection terminated|Connection timeout|too many clients|57P03|server closed the connection|getaddrinfo"; then
    echo "The database didn't answer (try $attempt): waiting a minute"
    sleep 60
    continue
  fi
  echo "Database rules" > /tmp/checks.failed
  tail -n 80 "$LOG"
  exit 1
done
echo "Database rules (unreachable three times)" > /tmp/checks.failed
exit 1
