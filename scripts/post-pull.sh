#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
if [ ! -f "$root/.deploy/node" ]; then
  echo 'Photo kiosk deployment is not installed. Run npm run deploy:install.' >&2
  exit 1
fi
IFS= read -r node_path < "$root/.deploy/node"
echo 'Git update completed. Rebuilding and deploying the photo kiosk…'
if ! "$node_path" "$root/scripts/deploy.mjs"; then
  echo 'Git update succeeded, but deployment failed. Check the output above; retry with npm run deploy.' >&2
  exit 1
fi
