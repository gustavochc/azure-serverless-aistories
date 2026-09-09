# Azure refactor infrastructure

This folder contains Azure deployment files for the AI Stories app.

- `main.bicep` - single template that deploys Azure Functions (Linux Consumption), Cosmos DB (SQL/Core API), Storage, Event Grid (topic + 3 subscriptions), the frontend App Service (Linux), and Key Vault. Parameterized by `prefix` so the whole stack can be duplicated into a new resource group.
- `serverless.bicep` - creates a separate Cosmos DB SQL API account in serverless capacity mode with the same database and containers as the application.
- `parameters.json` - parameter values for deployment (default `prefix: "aistories"`).
- `scripts/deploy.sh` - helper script for local deployment: `bash scripts/deploy.sh <resource-group> [location]`.
- `scripts/migrate-cosmos.js` - copies the four application containers from the old account to the new account without deleting the source.
- `scripts/cutover-cosmos.sh` - updates the Function App connection string and restarts the app after migration verification.

## Two-phase deploy

The Event Grid subscriptions (`generateAudio-sub`, `generateImages-sub`, `notifyStoryCreated-sub`) reference the function app's functions as `existing` resources, which must already be deployed. When deploying from scratch:

1. Deploy with `deployEventGridSubscriptions=false` (the default) to create the Function App, Cosmos DB, Storage, Event Grid topic, and frontend.
2. Deploy the function app code (zip deploy) so the functions are registered.
3. Re-run the bicep deployment with `deployEventGridSubscriptions=true` to wire up the 3 event subscriptions.

## Other notable parameters

- `cosmosFreeTier` (default `true`): explicitly enabled in `parameters.json`. Azure only allows one Cosmos DB free-tier account per subscription, and the setting must be selected when the account is created; it cannot be added to an existing account later. Moving an existing account to free tier therefore requires creating a new account, migrating the data, updating the Function App connection string, and then retiring the old account.
- `useServerlessCosmos` (default `false`): keeps the current provisioned account as the default. Set it to `true` after the serverless account has been created and verified so future infrastructure deployments continue using the migrated account.
- `enableAiGeneration` (default `false`) and `openAiApiKey`: required to actually generate stories/audio/images.
- `smtpUser`, `smtpPass`, `notifyEmailTo`: required for the `notifyStoryCreated` email notification to work.

## Temporary shutdown migration to serverless Cosmos DB

Cosmos DB has no pause or deallocate operation. The existing provisioned account must remain available until the data is copied and the application has been switched to a new account. The migration files in this folder keep the existing account untouched until the final retirement step.

The serverless account is intentionally named separately because capacity mode cannot be changed in place. Deploy it into the same resource group or another resource group in the same region:

```bash
az deployment group create \
	--resource-group ai-stories2 \
	--template-file azure/infra/serverless.bicep \
	--parameters prefix=aistories location=centralus cosmosServerlessName=aistories2serverlesscosmos
```

Install the Function App dependencies first, then provide both connection strings to the migration script. The source account is read-only from the script's perspective; the target is created and upserted into.

```bash
npm install --prefix azure/function-app

export SOURCE_COSMOS_CONNECTION_STRING="$(az cosmosdb keys list \
	--name aistories2cosmos --resource-group ai-stories2 \
	--type connection-strings --query 'connectionStrings[0].connectionString' -o tsv)"
export TARGET_COSMOS_CONNECTION_STRING="$(az cosmosdb keys list \
	--name aistories2serverlesscosmos --resource-group ai-stories2 \
	--type connection-strings --query 'connectionStrings[0].connectionString' -o tsv)"

node azure/infra/scripts/migrate-cosmos.js
```

Before cutover, stop writes to the app or disable the scheduled story generation. Run the migration a final time, verify the target data, and then update the Function App:

```bash
export AZURE_SUBSCRIPTION_ID=f21be898-541f-4e19-93df-f00b3ed6418d
node azure/infra/scripts/migrate-cosmos.js
bash azure/infra/scripts/cutover-cosmos.sh ai-stories2 aistories2serverlesscosmos aistories2-func
```

For future deployments, pass the serverless selector so `main.bicep` does not restore the old account's connection string:

```bash
az deployment group create \
	--resource-group ai-stories2 \
	--template-file azure/infra/main.bicep \
	--parameters @azure/infra/parameters.json \
		location=centralus \
		useServerlessCosmos=true \
		serverlessCosmosName=aistories2serverlesscosmos
```

Verify story reads, story creation, Event Grid processing, and child-profile updates before deleting or otherwise retiring `aistories2cosmos`. The serverless account bills for consumed request units and storage; it is not automatically free and does not support the Cosmos DB free-tier setting.

## Known gotcha

Azure permanently ties a resource group + region to one OS type for Dynamic SKU (Consumption) Function App plans. If a resource group previously hosted a Windows Consumption plan, you cannot convert it to Linux in place — deploy into a brand-new resource group instead.
