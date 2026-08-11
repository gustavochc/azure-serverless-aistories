# Low-Level Design (LLD)

## Azure Function App Structure

### `azure/function-app`

- `package.json`
  - `@azure/cosmos`
  - `@azure/eventgrid`
  - `@azure/functions`
  - `@azure/storage-blob`
  - `nodemailer`
  - `openai`

- `host.json`
  - Defines Azure Functions runtime version and Application Insights sampling settings.

- `local.settings.json`
  - Local development variables for function app settings.

- `tsconfig.json`
  - TypeScript configuration for Azure Functions.

- `shared/storyPrompt.ts`
  - `buildBedtimePrompt(names, theme)`: builds the OpenAI prompt shared by `createStory` and `createCustomStory`, targeting a calming bedtime story for a 3-year-old.
  - `cleanTitle(rawTitle)`: strips formatting from the model's first line to produce a clean title.

## Function Components

### `createStory`

- Trigger: `timerTrigger` (sparse cron by default, to avoid unexpected OpenAI costs).
- Purpose: generate a new story on a schedule, using all seeded characters and a random scene.
- Main steps:
  1. Create a Cosmos DB client from `COSMOS_DB_CONNECTION_STRING`.
  2. Load all documents from `characters` and `scenes` containers.
  3. Select a random scene and build an OpenAI prompt via `buildBedtimePrompt`.
  4. Call `openai.chat.completions.create()` (`gpt-4o-mini`) to generate story text.
  5. Parse the text into `title` and `description` (`cleanTitle` for the title).
  6. Create a story document in the `stories` container (`ttl: 172800`, i.e. 2 days).
  7. Publish a `StoryCreated` event to Event Grid.
- Output event payload: `id`, `title`, `description`, `scene`.

### `createCustomStory`

- Trigger: `httpTrigger` (`POST /api/createCustomStory`), `authLevel: function` (requires a function key — each call triggers billed OpenAI calls).
- Purpose: generate a one-off story with caller-supplied character names and theme, without touching seed data.
- Guarded by `ENABLE_AI_GENERATION` (returns `503` if not `true`).
- Request body: `{ "characters": string[] (1-4 names, required), "theme"?: string }`. If `theme` is omitted, a random scene from the seeded `scenes` container is used.
- Main steps: same OpenAI call + Cosmos create + Event Grid publish as `createStory`, but built from the request body instead of container data.
- Response: `202 Accepted` immediately with `{ id, title, message }` — audio/image generation continue asynchronously.
- **Note**: the `theme` string is later used verbatim as the `generateImages` DALL·E-style prompt — pass an actual story scene/theme, not an unrelated note, or the generated image will reflect the literal text instead of a story illustration.

### `generateAudio`

- Trigger: Event Grid event subscription (`generateAudio-sub`, filters `StoryCreated`).
- Purpose: generate speech audio for a story.
- Main steps:
  1. Parse `StoryCreated` event payload.
  2. Ensure Blob container exists.
  3. Call OpenAI's audio speech endpoint (`gpt-4o-mini-tts`) to synthesize audio.
  4. Upload MP3 to Blob Storage at `stories/{id}/audio.mp3`.
  5. Generate a SAS token valid for 2 days.
  6. Update the corresponding Cosmos DB story document with `audioURL`.

### `generateImages`

- Trigger: Event Grid event subscription (`generateImages-sub`, filters `StoryCreated`).
- Purpose: generate a story thumbnail image.
- Main steps:
  1. Parse `StoryCreated` event payload.
  2. Ensure Blob container exists.
  3. Call `openai.images.generate()` with `model: 'gpt-image-1'` and `prompt: detail.scene` (the story's scene/theme text, used verbatim).
  4. Upload the generated PNG to Blob Storage at `stories/{id}/image.png`.
  5. Generate a SAS token valid for 2 days.
  6. Update the corresponding Cosmos DB story document with `thumbnail`.

### `notifyStoryCreated`

- Trigger: Event Grid event subscription (`notifyStoryCreated-sub`, filters `StoryCreated`).
- Purpose: email a recipient that a new story is ready.
- Main steps:
  1. Parse `StoryCreated` event payload; skip if `NOTIFY_EMAIL_TO` isn't set.
  2. Create an SMTP transport (`nodemailer`) from `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`.
  3. Build the story URL as `${FRONTEND_BASE_URL}/story?id=${detail.id}`.
  4. Send an HTML + text email to `NOTIFY_EMAIL_TO` with the story title and link.
- **Gotcha**: `FRONTEND_BASE_URL` must be set (bicep computes it from the `prefix`) — if missing, the link falls back to an empty base path rather than a stale hardcoded hostname.

### `getStory`

- Trigger: HTTP GET request (`GET /api/story?id=...`), `authLevel: anonymous`.
- Purpose: return the story document for frontend rendering.
- Expected input: query param `id`.
- Response: story metadata + `audioURL` + `thumbnail` (if generated yet), or `404` if not found. Falls back to a mock story if `COSMOS_DB_CONNECTION_STRING` isn't configured.

## Data Model

### Cosmos DB (SQL/Core API, `@azure/cosmos`) containers

- `characters`
  - Stores character definitions used to build story prompts.
- `scenes`
  - Stores scene descriptions used to guide story generation.
- `stories`
  - Fields:
    - `id`, `title`, `description`, `characters`, `scene`, `createdAt`, `ttl` (2 days), `audioURL`, `thumbnail`

## Azure Infrastructure

### `azure/infra/main.bicep`

- Resources defined (all parameterized by `prefix` for full-stack duplication into a new resource group):
  - `Microsoft.Storage/storageAccounts` — Blob Storage for generated assets.
  - `Microsoft.Web/serverfarms` — two App Service Plans: one Linux Consumption (`Y1`) for the Function App, one Linux F1 (free) for the frontend.
  - `Microsoft.Web/sites` — the Function App (`kind: 'functionapp,linux'`, `linuxFxVersion: 'Node|22'`) and the frontend App Service (`kind: 'app,linux'`, `linuxFxVersion: 'NODE|24-lts'`).
  - `Microsoft.DocumentDB/databaseAccounts` + `sqlDatabases`/`containers` — Cosmos DB (SQL/Core API), `enableFreeTier` gated by the `cosmosFreeTier` param (only one free-tier account allowed per subscription).
  - `Microsoft.KeyVault/vaults` — optional, gated by `deployKeyVault`.
  - `Microsoft.EventGrid/topics` + 3 `eventSubscriptions` (`generateAudio-sub`, `generateImages-sub`, `notifyStoryCreated-sub`) — gated by `deployEventGridSubscriptions` since the target functions must already exist (two-phase deploy).

### App settings & secrets (Function App)

- `AzureWebJobsStorage`, `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING`, `WEBSITE_CONTENTSHARE`: Function App storage plumbing.
- `SCM_DO_BUILD_DURING_DEPLOYMENT` / `ENABLE_ORYX_BUILD`: both `false` — Linux zip-deploy auto-enables Oryx build by default, which conflicts with `WEBSITE_RUN_FROM_PACKAGE` and breaks the site with `503`s.
- `FUNCTIONS_WORKER_RUNTIME`: `node`
- `FUNCTIONS_EXTENSION_VERSION`: `~4`
- `WEBSITE_RUN_FROM_PACKAGE`: `1`
- `COSMOS_DB_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`
- `EVENTGRID_TOPIC_ENDPOINT`, `EVENTGRID_KEY`
- `ENABLE_AI_GENERATION`, `OPENAI_API_KEY`
- `WEBSITE_TIME_ZONE`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL_TO`
- `FRONTEND_BASE_URL`: computed as `https://${frontendName}.azurewebsites.net` (plain string, not a `frontendApp.properties.defaultHostName` reference — that would create a circular dependency since the frontend already references the function app's hostname for `API_BASE_URL`).
- `STORIES_DATABASE`, `CHARACTERS_COLLECTION`, `SCENES_COLLECTION`, `STORIES_COLLECTION`, `STORIES_CONTAINER`: default to `aiStoriesDb`/`characters`/`scenes`/`stories`/`stories` in code if unset.

## Frontend Details

### `azure/frontend`

- `package.json`
  - `next`, `react`, `react-dom`
- Pages:
  - `pages/index.tsx`
    - landing page with a sample story link
  - `pages/story.tsx`
    - `getServerSideProps` fetches `${API_BASE_URL}/api/story?id=...` server-side for the first render (or mock data if `USE_MOCK_DATA=true`)
    - client-side `useEffect` then polls `/api/story?id=...` (its own proxy route) every 5 seconds, up to 24 attempts, until `thumbnail` is present — this avoids a race where the page renders before slower image generation finishes
    - renders title, thumbnail, audio player, and story text (paragraphs split on `\n\n`)
  - `pages/api/story.ts`
    - server-side proxy: forwards `GET /api/story?id=...` to `${API_BASE_URL}/api/story?id=...` on the function app, so the browser can poll without needing `API_BASE_URL` exposed client-side
  - `pages/api/health.ts`
    - health check endpoint
  - `pages/api/settings.ts`
    - frontend settings endpoint

### Frontend configuration

- Expects environment variable `API_BASE_URL` (set by bicep to `https://${functionApp.properties.defaultHostName}`) and `USE_MOCK_DATA`.
- Fetches story from backend function app endpoint via the `/api/story` proxy.
- Renders generated story assets once (if) they appear on a later poll.

## Security and Access Control

- Story assets are stored privately in Blob Storage.
- Shared access signatures (SAS) provide time-limited (2-day), read-only access.
- OpenAI API key, SMTP credentials, and Cosmos/Storage connection strings are never exposed to the browser — the frontend only receives `API_BASE_URL`.
- `createCustomStory` requires a function key (not anonymous) since it triggers billed OpenAI calls.
- Cosmos DB credentials remain in backend secrets/app settings.
