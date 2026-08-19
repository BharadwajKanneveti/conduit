#!/usr/bin/env bash
# Install apt packages on a GitHub Ubuntu runner, tolerating a flaky mirror.
#
# `apt-get update` on the hosted runners intermittently stops responding rather
# than failing. It hung three separate jobs on one pull request (PR #812), each
# time burning the job's whole timeout without ever reaching a compiler. An
# unbounded hang is the worst shape available: it wastes the full budget, and a
# run stuck in progress also blocks `gh run rerun --failed` on the jobs that
# genuinely failed.
#
# So bound each attempt and retry. A bad mirror costs seconds instead of the job.
# `timeout` sends SIGTERM at the limit, which apt handles cleanly.
#
# The download side of `apt-get install` needs the same treatment, and only got
# it later: with `update` bounded, a throttled mirror moved the hang one step
# down. On PR #813 the mirror served ~12 kB/s, so the install crept through 130
# small packages and then died inside the 27 MB libwebkit2gtk-4.1-0, twice,
# each time burning the full 45-minute budget. Only the heavy WebKitGTK job hit
# it; the jobs asking for four packages finished in three minutes.
#
# Usage: scripts/ci-apt-install.sh <package>...
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <package>..." >&2
  exit 2
fi

attempts=3
per_attempt_secs=120
# Downloads are bulkier than an index refresh, so they get their own budget:
# a healthy WebKitGTK fetch is well under two minutes. Worst case the two loops
# together are 3x120s + 3x300s plus the retry sleeps, so roughly 21 minutes -
# still a backstop well inside the job's 45, which is the point.
download_attempt_secs=300
# SIGTERM is the polite ask. An apt wedged on a dead socket can sit through it,
# which would put the unbounded wait straight back; follow up with SIGKILL.
kill_after_secs=30

run_apt() {
  local budget="$1"
  shift
  sudo timeout --kill-after="$kill_after_secs" "$budget" apt-get "$@"
}

updated=
for attempt in $(seq 1 "$attempts"); do
  if run_apt "$per_attempt_secs" update; then
    updated=1
    break
  fi
  echo "apt-get update attempt ${attempt}/${attempts} failed or hung; retrying" >&2
  sleep 5
done

if [ -z "$updated" ]; then
  echo "apt-get update failed ${attempts} times; see the apt error above" >&2
  exit 1
fi

# Fetch first, on a bound, so a stalled mirror is interrupted and retried. This
# is safe to cut off mid-flight: apt keeps each completed .deb in
# /var/cache/apt/archives, so a retry resumes with only what is still missing
# instead of starting the whole set again.
downloaded=
for attempt in $(seq 1 "$attempts"); do
  # Refresh the index before each retry, never on the first pass. A mirror that
  # publishes a new version between our update and our download 404s every
  # attempt on the version we were told to ask for, and retrying the same stale
  # plan just burns the budget three times over.
  if [ "$attempt" -gt 1 ] && ! run_apt "$per_attempt_secs" update; then
    echo "index refresh before download attempt ${attempt} failed; trying the download anyway" >&2
  fi
  if run_apt "$download_attempt_secs" install -y --download-only "$@"; then
    downloaded=1
    break
  fi
  echo "apt-get download attempt ${attempt}/${attempts} failed or hung; retrying" >&2
  sleep 5
done

if [ -z "$downloaded" ]; then
  echo "apt-get could not download the packages after ${attempts} attempts; see the apt error above" >&2
  exit 1
fi

# Install straight from the cache the loop above filled. `--no-download` is what
# makes "offline" true rather than merely likely: without it this is a fresh
# acquire session, so one truncated or superseded .deb sends it back to the
# mirror unbounded, which is the exact hang this script exists to stop. A
# missing file now fails fast and loudly instead. Deliberately no `-m`: that
# would drop the missing package and install a quiet subset.
#
# No timeout here on purpose. There is no network left to stall on, and a
# SIGTERM landing inside dpkg is the one interruption that leaves a
# half-configured system needing `dpkg --configure -a`.
sudo apt-get install -y --no-download "$@"
