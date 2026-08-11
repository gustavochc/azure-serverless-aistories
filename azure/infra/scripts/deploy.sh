#!/bin/bash
set -euo pipefail

if [ -z "${1-}" ]; then
  echo "Usage: $0 <resource-group> [location]"
  exit 1
fi

RESOURCE_GROUP=$1
LOCATION=${2:-centralus}

az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$(dirname "$0")/../main.bicep" \
  --parameters @"$(dirname "$0")/../parameters.json" location="$LOCATION"
