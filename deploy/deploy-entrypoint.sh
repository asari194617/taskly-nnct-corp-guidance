#!/usr/bin/env bash
set -euo pipefail
# OpenSSH forced command: no shell, SCP, forwarding, or arbitrary remote commands.
if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deploy <commit SHA> is permitted.' >&2
  exit 2
fi
sha=${BASH_REMATCH[1]}
cd /home/ubuntu/taskly-nnct-corp-guidance
exec 9>.deploy.lock
flock -n 9 || { echo 'A deployment is already running.' >&2; exit 2; }
umask 077
archive=$(mktemp .deploy-input.XXXXXXXX)
validated=$(mktemp .deploy-validated.XXXXXXXX)
trap 'rm -f "$archive" "$validated"' EXIT
head -c 536870913 > "$archive"
if [ "$(wc -c < "$archive")" -gt 536870912 ]; then
  echo 'Docker archive is too large.' >&2
  exit 2
fi
python3 ./validate-image-archive.py "$archive" "$validated" "$sha"
docker load -i "$validated"
./remote-deploy.sh "$sha"
