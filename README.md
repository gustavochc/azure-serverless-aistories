# Azure AI Stories

This app has been created in Azure with the following structure:

- `azure/infra` - Azure Bicep deployment for Storage, App Service (Linux, function app + frontend), Cosmos DB, Event Grid, and Key Vault.
- `azure/function-app` - Azure Functions app for story generation (scheduled + on-demand), audio generation, image generation, story retrieval, and email notification.
- `azure/frontend` - Next.js frontend (polls for audio/image assets after story creation).
- `azure/architecture.svg` - Visual architecture diagram for the Azure deployment.
- `azure/WORKFLOW.md` - Sequence/flow diagram of the end-to-end story creation -> asset generation -> notification -> rendering flow.

## Local development

### Frontend

```
cd azure/frontend
npm install
npm run dev
```

### Functions

```
cd azure/function-app
npm install
npm run build
func start
```

## Deploy to Azure for development

For the lowest-cost development experience, use:

- Azure Functions Consumption plan (Linux)
- Cosmos DB free tier
- Storage account with standard LRS
- App Service Linux F1 (free tier) for the frontend
- Key Vault only if you truly need secret storage

### Cheapest workflow

1. Run the frontend locally with mock data.
2. Keep the backend disabled unless you need to test the real function app.
3. Only enable AI generation when you are ready to pay for OpenAI calls.
4. Use Azure only for a single manual test run, not for continuous development.

1. Create an Azure resource group.
2. Deploy infra:

```
cd azure/infra
bash scripts/deploy.sh <resource-group> [location]
```

3. Configure Azure Function app settings for `OPENAI_API_KEY`, `COSMOS_DB_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, `EVENTGRID_TOPIC_ENDPOINT`, `EVENTGRID_KEY`, `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, `NOTIFY_EMAIL_TO`, `FRONTEND_BASE_URL`, and container names. Most of these are already set by `main.bicep` on every deploy — see `azure/infra/README.md`.

4. Deploy the function app from `azure/function-app`.

5. Deploy the frontend to Azure App Service (Linux) or keep it local while you develop.

### Cost-saving tips

- Keep the timer trigger disabled or set it to a very sparse schedule.
- Avoid generating audio and images on every run.
- Use manual triggering and local development for most work.
- Skip Key Vault during early testing unless you need it.
- Set `USE_MOCK_DATA=true` to keep the frontend fully free during development.
- Set `ENABLE_AI_GENERATION=false` unless you explicitly want to pay for AI calls.
