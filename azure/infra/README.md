# Azure refactor infrastructure

This folder contains Azure deployment files for the AI Stories app.

- `main.bicep` - single template that deploys Azure Functions (Linux Consumption), Cosmos DB (SQL/Core API), Storage, Event Grid (topic + 3 subscriptions), the frontend App Service (Linux), and Key Vault. Parameterized by `prefix` so the whole stack can be duplicated into a new resource group.
- `parameters.json` - parameter values for deployment (default `prefix: "aistories"`).
- `scripts/deploy.sh` - helper script for local deployment: `bash scripts/deploy.sh <resource-group> [location]`.

## Two-phase deploy

The Event Grid subscriptions (`generateAudio-sub`, `generateImages-sub`, `notifyStoryCreated-sub`) reference the function app's functions as `existing` resources, which must already be deployed. When deploying from scratch:

1. Deploy with `deployEventGridSubscriptions=false` (the default) to create the Function App, Cosmos DB, Storage, Event Grid topic, and frontend.
2. Deploy the function app code (zip deploy) so the functions are registered.
3. Re-run the bicep deployment with `deployEventGridSubscriptions=true` to wire up the 3 event subscriptions.

## Other notable parameters

- `cosmosFreeTier` (default `true`): set to `false` when deploying a second stack in the same subscription, since Azure only allows one Cosmos DB free-tier account per subscription.
- `enableAiGeneration` (default `false`) and `openAiApiKey`: required to actually generate stories/audio/images.
- `smtpUser`, `smtpPass`, `notifyEmailTo`: required for the `notifyStoryCreated` email notification to work.

## Known gotcha

Azure permanently ties a resource group + region to one OS type for Dynamic SKU (Consumption) Function App plans. If a resource group previously hosted a Windows Consumption plan, you cannot convert it to Linux in place — deploy into a brand-new resource group instead.
