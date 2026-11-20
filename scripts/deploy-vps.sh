#!/usr/bin/env bash
# Retired: this used to copy a local Gate's credentials and state to the target.
set -eu
printf '%s
' 'deploy-vps.sh was retired; it does not connect to the target.'   'For a clean deployment, run npm run build:release and follow the Cloud archive README.'   'For migration, back up and restore state and keys explicitly. See DEPLOY.md.' >&2
exit 2
