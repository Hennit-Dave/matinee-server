#!/usr/bin/env bash
# Fills a showing's waiting room with synthetic users so ONE phone can show a long line counting down (slice 5d, ADR 0017).
#
#   docs/evidence/traffic-5d/waiting-room/demo-fill.sh <apiBase> <showtimeId> [users=12] [holdSeconds=60]
#
# What it does:
#   1. `users` synthetic installs join the line in order. The first WAITING_ROOM_MAX_ACTIVE are let straight in; the rest queue.
#   2. For `holdSeconds` it keeps every one of them alive (polling is the heartbeat), so the room stays full and the line stays long.
#      Open the showing on the phone now: it joins BEHIND all of them ("12 people ahead of you").
#   3. Then it drains: the admitted users leave one every 6 s, and each user leaves as soon as they are let in, so the line moves at the server's
#      fixed admission rate and the phone's number counts down to "you're next" and then into seat selection.
# Needs only bash, curl and uuidgen. Ctrl+C leaves everyone and exits. Nothing here is a secret or touches the database.
set -u
BASE="${1:?usage: demo-fill.sh <apiBase> <showtimeId> [users] [holdSeconds]}"
SHOWTIME="${2:?usage: demo-fill.sh <apiBase> <showtimeId> [users] [holdSeconds]}"
USERS="${3:-12}"
HOLD="${4:-60}"
URL="$BASE/showtimes/$SHOWTIME/queue"
ids=(); state=()   # state: admitted | waiting | gone

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
leave_all() { for id in "${ids[@]}"; do curl -s -o /dev/null -X DELETE -H "X-Client-Id: $id" "$URL"; done; }
trap 'say "leaving everyone"; leave_all; exit 0' INT TERM

for ((i = 0; i < USERS; i++)); do
  id="$(uuidgen | tr 'A-Z' 'a-z')"; ids+=("$id")
  body="$(curl -s -X POST -H "X-Client-Id: $id" "$URL")"
  case "$body" in
    *'"admitted"'*) state+=(admitted) ;;
    *'"waiting"'*) state+=(waiting) ;;
    *) say "join failed for user $((i + 1)): $body"; state+=(gone) ;;
  esac
done
say "joined $USERS users: $(printf '%s\n' "${state[@]}" | sort | uniq -c | tr '\n' ' ')"
say "holding the line for ${HOLD}s: open the showing on the phone now"

end=$((SECONDS + HOLD))
while ((SECONDS < end)); do
  for i in "${!ids[@]}"; do
    [ "${state[$i]}" = gone ] && continue
    body="$(curl -s -H "X-Client-Id: ${ids[$i]}" "$URL")"
    case "$body" in *'"admitted"'*) state[$i]=admitted ;; *'"waiting"'*) state[$i]=waiting ;; esac
  done
  sleep 3
done

say "draining: admitted users leave one every 6 s; each other user leaves the moment they are let in"
while :; do
  active=0
  for i in "${!ids[@]}"; do
    [ "${state[$i]}" = gone ] && continue
    active=1
    body="$(curl -s -H "X-Client-Id: ${ids[$i]}" "$URL")"
    case "$body" in
      *'"admitted"'*)
        if [ "${state[$i]}" = waiting ]; then say "user $((i + 1)) is let in, and leaves"; curl -s -o /dev/null -X DELETE -H "X-Client-Id: ${ids[$i]}" "$URL"; state[$i]=gone; fi ;;
      *'"waiting"'*) state[$i]=waiting ;;
      *) state[$i]=gone ;;
    esac
  done
  # one of the original occupants leaves every 6 s, which frees a slot for the head of the line
  for i in "${!ids[@]}"; do
    if [ "${state[$i]}" = admitted ]; then say "user $((i + 1)) (admitted) leaves"; curl -s -o /dev/null -X DELETE -H "X-Client-Id: ${ids[$i]}" "$URL"; state[$i]=gone; break; fi
  done
  [ "$active" = 0 ] && break
  sleep 6
done
say "done"
