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
gzip -dc | docker load
exec ./remote-deploy.sh "$sha"
