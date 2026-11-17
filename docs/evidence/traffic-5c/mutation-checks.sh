#!/usr/bin/env bash
# Proves the 5c tests can FAIL: breaks the limiter seven ways, one at a time, runs the tests that should notice, and
# restores the file from git after each. Needs the throwaway test env (TEST_DATABASE_*, TEST_REDIS_URL on loopback).
#
#   source <env> && bash docs/evidence/traffic-5c/mutation-checks.sh
#
# The tree must be clean (everything committed) so `git checkout --` can restore it.
set -u
cd "$(dirname "$0")/../../.."

if [ -n "$(git status --porcelain src)" ]; then echo "src/ has uncommitted changes: commit first"; exit 2; fi

run() { node --import tsx --test --test-concurrency=1 --test-force-exit "$@" 2>&1; }
caught=0; missed=0

mutate() { # name, file, python-edit, tests...
  local name="$1" file="$2" edit="$3"; shift 3
  python3 - "$file" "$edit" <<'PY'
import sys
path, edit = sys.argv[1], sys.argv[2]
src = open(path).read()
for one in edit.split('\n@@@\n'):          # several edits to one file are separated by a line holding @@@
    old, new = one.split('=>>')
    assert old in src, f"mutation target not found in {path}: {old!r}"
    src = src.replace(old, new, 1)
open(path, 'w').write(src)
PY
  local out; out="$(run "$@")"
  local failed; failed="$(printf '%s\n' "$out" | grep -E '^ℹ fail' | awk '{print $3}')"
  git checkout -q -- "$file"
  if [ "${failed:-0}" -gt 0 ]; then
    caught=$((caught + 1)); echo "CAUGHT  ($failed failing)  $name"
    printf '%s\n' "$out" | grep -E '^✖' | grep -v 'failing tests' | sed 's/ ([0-9.]*ms)$//' | sort -u | head -4 | sed 's/^/          /'
  else
    missed=$((missed + 1)); echo "MISSED  $name"
  fi
}

SW=src/ratelimit/slidingWindow.ts
LM=src/ratelimit/limiter.ts
INT="src/ratelimit/slidingWindow.integration.test.ts"
HTTP="src/ratelimit/limiter.http.integration.test.ts"

mutate "1. fixed window: forget the previous window (weight 0)" $SW \
  "local weight = remaining / win=>>local weight = 0" $INT $HTTP

mutate "2. read-then-write: the script only DECIDES, the caller counts in a separate call (the race)" $SW \
  "  redis.call('INCR', KEYS[2 * i - 1])
  redis.call('PEXPIRE', KEYS[2 * i - 1], 2 * win)=>>  -- counted later, by the caller
@@@
      if (numbers[0] === 1) return { allowed: true };=>>      if (numbers[0] === 1) {
        for (const key of keys.filter((_, i) => i % 2 === 0)) {
          await redis.incr(key);
          await redis.pexpire(key, 2 * windowMs);
        }
        return { allowed: true };
      }" $INT

mutate "3. count refused requests too (hammering extends the lock-out)" $SW \
  "  local reply = {0, math.max(1, math.ceil(retry - 1e-6))}=>>  for i = 1, n do redis.call('INCR', KEYS[2 * i - 1]); redis.call('PEXPIRE', KEYS[2 * i - 1], 2 * win) end
  local reply = {0, math.max(1, math.ceil(retry - 1e-6))}" $INT $HTTP

mutate "4. skip the address counter (user only)" $LM \
  "if (address.resolved) {=>>if (address.resolved && false) {" src/ratelimit/limiter.test.ts $HTTP

mutate "5. fail CLOSED instead of open" $LM \
  "          next();
          return;
        }

        if (result.allowed) {=>>          next(new ApiError('service_unavailable'));
          return;
        }

        if (result.allowed) {" src/ratelimit/limiter.test.ts $HTTP

mutate "6. limiter AFTER body parsing and validation (a flood costs a JSON parse and a Zod run)" src/bookings/routes.ts \
  "router.post('/:id/holds', callerId, limit('hold'), ...parsedInput, async=>>router.post('/:id/holds', callerId, ...parsedInput, limit('hold'), async" $HTTP

mutate "7. trust every proxy (\`true\`): any caller can write its own address" src/api/app.ts \
  "app.set('trust proxy', [...TRUSTED_PROXY_RANGES]);=>>app.set('trust proxy', true);" src/api/rateLimitWiring.test.ts

echo
echo "caught: $caught   missed: $missed"
echo "tree after restore: $(git status --porcelain src | wc -l | tr -d ' ') modified files in src/"
[ "$missed" -eq 0 ]
