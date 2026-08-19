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
# a healthy WebKitGTK fetch is well under two minutes, and 3 x 300s still caps
# the whole step at 15 rather than letting it eat the job.
download_attempt_secs=300

updated=
for attempt in $(seq 1 "$attempts"); do
  if sudo timeout "$per_attempt_secs" apt-get update; then
    updated=1
    break
  fi
  echo "apt-get update attempt ${attempt}/${attempts} failed or hung; retrying" >&2
  sleep 5
done

if [ -z "$updated" ]; then
  echo "apt-get update failed ${attempts} times; the mirror is unreachable" >&2
  exit 1
fi

# Fetch first, on a bound, so a stalled mirror is interrupted and retried. This
# is safe to cut off mid-flight: apt keeps each completed .deb in
# /var/cache/apt/archives, so a retry resumes with only what is still missing
# instead of starting the whole set again.
downloaded=
for attempt in $(seq 1 "$attempts"); do
  if sudo timeout "$download_attempt_secs" apt-get install -y --download-only "$@"; then
    downloaded=1
    break
  fi
  echo "apt-get download attempt ${attempt}/${attempts} failed or hung; retrying" >&2
  sleep 5
done

if [ -z "$downloaded" ]; then
  echo "apt-get could not download the packages after ${attempts} attempts; the mirror is unreachable" >&2
  exit 1
fi

# Unbounded on purpose. Everything is in the local cache by now, so this is
# fast and offline, and a SIGTERM landing inside dpkg is the one interruption
# that leaves a half-configured system needing `dpkg --configure -a`.
sudo apt-get install -y "$@"
