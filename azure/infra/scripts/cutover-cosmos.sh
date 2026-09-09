#!/bin/bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <resource-group> <serverless-account-name> [function-app-name]"
  exit 1
fi

RESOURCE_GROUP=$1
SERVERLESS_ACCOUNT_NAME=$2
FUNCTION_APP_NAME=${3:-aistories2-func}
SUBSCRIPTION=${AZURE_SUBSCRIPTION_ID:-}

if [ -z "$SUBSCRIPTION" ]; then
  echo "Set AZURE_SUBSCRIPTION_ID before running the cutover."
  exit 1
fi

read -r -p "Update $FUNCTION_APP_NAME to use $SERVERLESS_ACCOUNT_NAME and restart it? [y/N] " confirmation
if [[ "$confirmation" != "y" && "$confirmation" != "Y" ]]; then
  echo "Cutover cancelled."
  exit 0
fi

CONNECTION_STRING=$(az cosmosdb keys list \
  --name "$SERVERLESS_ACCOUNT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" \
  --type connection-strings \
  --query 'connectionStrings[0].connectionString' \
  --output tsv)

if [ -z "$CONNECTION_STRING" ]; then
  echo "Could not retrieve a connection string for $SERVERLESS_ACCOUNT_NAME."
  exit 1
fi

az functionapp config appsettings set \
  --name "$FUNCTION_APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" \
  --settings "COSMOS_DB_CONNECTION_STRING=$CONNECTION_STRING" \
  --only-show-errors \
  --output none

az functionapp restart \
  --name "$FUNCTION_APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" \
  --only-show-errors

echo "Cutover complete. Verify the application before retiring the old Cosmos account."
