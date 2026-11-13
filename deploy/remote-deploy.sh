#!/bin/sh
set -eu
# The image is received over the restricted SSH command; never pull mutable tags.
sha=${1:?commit SHA required}
case "$sha" in *[!0-9a-f]*|'') echo 'Invalid commit SHA' >&2; exit 2;; esac
[ "${#sha}" -eq 40 ] || { echo 'Invalid commit SHA length' >&2; exit 2; }
[ -f .env.production ] || { echo '.env.production missing' >&2; exit 2; }
[ -d data ] || { echo 'Private document directory missing' >&2; exit 2; }
image="ghcr.io/asari194617/taskly-nnct-corp-guidance:$sha"
revision=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[ "$revision" = "$sha" ] || { echo 'Image revision mismatch' >&2; exit 2; }
# First release imports only the private host-side source. Later data updates are explicit.
if [ ! -f .dataset-imported ]; then
  docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges:true \
    --env-file .env.production --network infra_default \
    -v "$PWD/data:/data:ro" --entrypoint /usr/local/bin/import-guidance \
    "$image" -input /data/guidance.json
  touch .dataset-imported
fi
previous=''
if [ -f deployed-sha ]; then previous=$(cat deployed-sha); fi
export IMAGE_TAG="$sha"
if docker compose -f compose.production.yaml up -d --pull never --wait --wait-timeout 90 api; then
  printf '%s\n' "$sha" > deployed-sha.tmp
  mv deployed-sha.tmp deployed-sha
else
  echo 'New API failed readiness.' >&2
  case "$previous" in *[!0-9a-f]*|'') previous='';; esac
  if [ "${#previous}" -eq 40 ]; then
    echo "Restoring previous release $previous" >&2
    export IMAGE_TAG="$previous"
    docker compose -f compose.production.yaml up -d --pull never --wait --wait-timeout 90 api
  else
    echo 'No previous release exists; stopping the failed initial deployment.' >&2
    docker compose -f compose.production.yaml stop api
  fi
  exit 1
fi
