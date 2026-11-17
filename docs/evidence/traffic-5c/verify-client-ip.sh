#!/usr/bin/env bash
# =====================================================================================================================
#  !!  NOT YET RUN AGAINST THE REAL RAILWAY EDGE.  RUN THIS IN THE DEPLOY SLICE, AGAINST THE DEPLOYED API.  !!
#
#  Slice 5c could only prove client-address handling against a local stand-in for the edge (see
#  verify-client-ip-rehearsal.txt). Railway publishes no hop count and its answers disagree on whether the edge
#  replaces or appends to X-Forwarded-For (ADR 0016), so the only real proof is this: two black-box checks that need
#  no log access and no debug endpoint. Save the output of a real run as docs/evidence/traffic-5c/railway-edge-check.txt.
# =====================================================================================================================
#
# What it does. Every request is POST /showtimes/<random>/holds with an EMPTY body: the rate limiter runs before
# validation, so each request is counted by the limiter and then refused with a harmless 400. No seat is touched.
# The hold limit is 40 per address per minute (src/ratelimit/policies.ts).
#
#   spoof  Run from ONE machine. Sends up to 60 requests, each with a different random X-Client-Id (so the per-user
#          counter never trips) and a different forged X-Forwarded-For and X-Real-IP. If the limiter really resolves
#          your address, the forged values change nothing and the 41st request is a 429. If the forged values worked,
#          every request looks like a new caller and there is never a 429.
#              PASS: a 429 appears at request 41 or earlier.      FAIL: no 429 in 60 requests.
#
#   share  Run from a SECOND, DIFFERENT network (a phone hotspot, say: a different public address, NOT the same
#          carrier address as the first), within 60 seconds of a `spoof` run. Sends ONE request. If addresses are
#          resolved properly it is a 400 (the limiter let you through). If everybody has been collapsed onto the
#          edge's own address it is a 429, because the first machine used up that shared bucket.
#              PASS: 400.      FAIL: 429.
#
# Wait 2 minutes between runs from the same machine, so one run's counters do not count against the next.
#
#   bash verify-client-ip.sh https://<the deployed API> spoof
#   bash verify-client-ip.sh https://<the deployed API> share
#
# EXTRA_HEADER="Name: value" adds one header to every request. Only the local rehearsal uses it.
# Exit status: 0 PASS, 1 FAIL, 2 usage or an unexpected answer.
set -u

BASE="${1:-}"; MODE="${2:-}"
if [ -z "$BASE" ] || { [ "$MODE" != spoof ] && [ "$MODE" != share ]; }; then
  echo "usage: bash verify-client-ip.sh <base-url> spoof|share"; exit 2
fi
BASE="${BASE%/}"

EXTRA=()
[ -n "${EXTRA_HEADER:-}" ] && EXTRA=(-H "$EXTRA_HEADER")

uuid() { uuidgen | tr 'A-Z' 'a-z'; }
ip() { echo "$((RANDOM % 150 + 20)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"; }

# One counted-then-refused request. Prints the HTTP status ("000" if the request itself failed).
hold() {
  curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "$BASE/showtimes/$(uuid)/holds" \
    -H 'content-type: application/json' -H "x-client-id: $(uuid)" "$@" ${EXTRA[@]+"${EXTRA[@]}"} -d '{}'
}

echo "target: $BASE   mode: $MODE   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [ "$MODE" = share ]; then
  code="$(hold)"
  echo "one request from this network -> $code"
  case "$code" in
    400) echo "PASS: not limited. This network has its own bucket (callers are not collapsed onto the edge's address)."; exit 0 ;;
    429) echo "FAIL: 429. Either every caller is being counted as one address (collapsed onto the edge), or this network shares a public address with the machine that ran 'spoof' (same carrier NAT? use a genuinely different network)."; exit 1 ;;
    *)   echo "UNEXPECTED status $code (expected 400 or 429)"; exit 2 ;;
  esac
fi

first429=""; odd=0
for n in $(seq 1 60); do
  code="$(hold -H "X-Forwarded-For: $(ip)" -H "X-Real-IP: $(ip)")"
  case "$code" in
    400) ;;
    429) first429="$n"; break ;;
    *) odd=$((odd + 1)); echo "request $n -> $code (unexpected)" ;;
  esac
done

if [ -n "$first429" ]; then
  echo "first 429 at request $first429 (expected 41: the hold limit is 40 per address per minute)"
  if [ "$first429" -le 41 ]; then
    echo "PASS: forged X-Forwarded-For / X-Real-IP did not dodge the address limit."; exit 0
  fi
  echo "PASS with a note: refused, but later than 41. Leftover counters from a recent run, or the limit differs from policies.ts."; exit 0
fi
echo "FAIL: 60 requests with forged address headers and fresh install ids, never a 429."
echo "Either the forged headers are being believed (the address limit can be dodged), or the address counter is not being applied at all"
echo "(look for 'client_ip_unresolved' warnings in the API log: the edge's own address is being seen instead of the caller's)."
[ "$odd" -gt 0 ] && echo "($odd requests answered something other than 400, so this run proves nothing: fix that first)"
exit 1
