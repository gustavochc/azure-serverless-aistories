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

- `shared/types.ts`
  - `StoryPackage`, `StoryScene`, `CharacterSheet`, `TtsInstructions`, `StoryAudio`, `StoryAssetsStatus`, `StoryCreatedEventData`: shared TypeScript contract for the Story Package used by every function.

- `shared/storyPrompt.ts`
  - `buildBedtimePrompt(names, theme, memoryContext?)`: builds the OpenAI prompt shared by `createStory` and `createCustomStory`. Targets a calming bedtime story for a 3-year-old (Spanish, Disney-inspired, ~250-450 words / ~90-120s) and instructs the model to respond with **only** a strict JSON Story Package (title, story, description, characterSheet, ttsInstructions, 6 scenes with per-scene image prompts, `memoryUpdate`, audio/assetsStatus placeholders). When `memoryContext` (built by `shared/childProfile.ts`'s `buildMemoryContext`) is non-empty, it's appended so the model can reuse established friends/places/elements and report new ones.
  - `cleanTitle(rawTitle)`: strips formatting artifacts from a title string; kept for backwards compatibility, used internally on the parsed `title` field.
  - `safeParseStoryPackage(raw, fallbackName?)`: sanitizes the raw LLM response — strips markdown/code fences, `JSON.parse`s it, and guarantees a well-formed `StoryPackage` even on partial/malformed output: forces exactly 6 scenes (padding with defaults from `SCENE_TEMPLATE`), computes `startOffsetMs`/`endOffsetMs` from `startTime`/`endTime` when missing, defaults `description` to `story` when absent, defaults every scene's `status` to `"pending"`, and normalizes `memoryUpdate` (`normalizeMemoryUpdate`) to always have `newFriends`/`newPlaces`/`newElements` arrays.
  - `msToTime(ms)` / `parseTimeToMs(time)`: convert between milliseconds and `mm:ss` display strings, used by both the initial LLM-estimated offsets and `generateAudio`'s recomputed exact offsets.
  - `buildStorySsmlFromScenes(scenes)`: builds a `<speak>` document with a `<bookmark>` per scene (`escapeSsmlText` escapes narration text for XML safety). Wired into `generateAudio`, which stores the result on the story's `ssml` field — not yet consumed by the TTS call itself, since OpenAI's `gpt-4o-mini-tts` endpoint doesn't accept SSML or return bookmark timestamps; it's prepared for a future SSML-capable provider (e.g. Azure Speech).

- `shared/childProfile.ts` (Fase 2)
  - `slugifyName(name)`: normalizes a character name into a stable Cosmos item id (e.g. `"Vega"` -> `"vega"`), stripping accents/diacritics and non-alphanumeric characters.
  - `loadChildProfile(container, name)` / `loadChildProfiles(container, names)`: read one or more `childProfiles` documents by slugified id; missing profiles are silently skipped (new character, no memory yet).
  - `buildMemoryContext(profiles)`: builds the Spanish-language memory block injected into `buildBedtimePrompt` — lists the established `appearance`, recurring friends/places/elements (deduplicated), and instructs the model to report any new ones via `memoryUpdate`. Returns an empty string if there's no prior memory.
  - `upsertChildProfiles(container, names, storyId, appearance, memoryUpdate)`: merges the LLM's reported `memoryUpdate` (new friends/places/elements) into each named character's profile, capping each list at the last 12 items and the `storyIds` history at the last 20; called after story creation and is non-fatal (failures are logged, never block the response).

- `shared/imageGeneration.ts` (Fase 3)
  - `generateAndUploadSceneImage(openai, containerClient, sharedKeyCredential, storyId, sceneNumber, prompt)`: shared logic to call `openai.images.generate()` (`gpt-image-1`), upload the PNG to `stories/{id}/images/scene-{n}.png`, and return a 2-day SAS URL. Used by both `generateSceneImage` (the normal Event Grid fan-out path) and `generateImages`'s local-dev fallback (sequential, when no Event Grid topic is configured).
  - `updateSceneStatus(storiesContainer, storyId, sceneNumber, patch)`: re-reads the story doc, patches a single scene's `imageUrl`/`status`, and recomputes `assetsStatus` (`imagesGenerated`, `totalImages`, `completed`).

## Function Components

### `createStory`

- Trigger: `timerTrigger` (sparse cron by default, to avoid unexpected OpenAI costs).
- Purpose: generate a new Story Package on a schedule, using all seeded characters and a random scene.
- Main steps:
  1. Create a Cosmos DB client from `COSMOS_DB_CONNECTION_STRING`.
  2. Load all documents from `characters` and `scenes` containers.
  3. Select a random scene and build an OpenAI prompt via `buildBedtimePrompt`.
  4. Call `openai.chat.completions.create()` (`gpt-4o-mini`) to generate the Story Package JSON.
  5. Parse/sanitize the response with `safeParseStoryPackage()`.
  6. Create a story document in the `stories` container (full Story Package + legacy `description`/`thumbnail`/`audioURL`, `ttl: 172800`, i.e. 2 days).
  7. Publish a `StoryCreated` event to Event Grid.
- Output event payload: `id`, `title`, `story`, `description`, `scenes`, `characterSheet`, `estimatedDurationSeconds`.

### `createCustomStory`

- Trigger: `httpTrigger` (`POST /api/createCustomStory`), `authLevel: function` (requires a function key — each call triggers billed OpenAI calls).
- Purpose: generate a one-off Story Package with caller-supplied character names and theme, without touching seed data.
- Guarded by `ENABLE_AI_GENERATION` (returns `503` if not `true`).
- Request body: `{ "characters": string[] (1-4 names, required), "theme"?: string }`. If `theme` is omitted, a random scene from the seeded `scenes` container is used.
- Main steps:
  1. Load each named character's `childProfiles` document (`loadChildProfiles`) and build a memory context block (`buildMemoryContext`) — failures are caught and treated as "no memory yet".
  2. Call OpenAI (`buildBedtimePrompt` with the memory context + `safeParseStoryPackage`) to generate the Story Package JSON (including `memoryUpdate`).
  3. Create the story doc in Cosmos + publish `StoryCreated` to Event Grid, same as `createStory`.
  4. Merge `memoryUpdate` into each character's profile (`upsertChildProfiles`) — non-fatal, logged but never blocks the response.
- Response: `202 Accepted` immediately with `{ id, title, message }` — audio/image generation continue asynchronously.

### `generateAudio`

- Trigger: Event Grid event subscription (`generateAudio-sub`, filters `StoryCreated`).
- Purpose: generate speech audio for the full story text and compute exact per-scene sync offsets.
- Main steps:
  1. Parse `StoryCreated` event payload (`story`, falling back to `description`, as the narration source).
  2. Ensure Blob container exists.
  3. Call OpenAI's audio speech endpoint (`gpt-4o-mini-tts`) to synthesize audio.
  4. Upload MP3 to Blob Storage at `stories/{id}/audio.mp3`.
  5. Generate a SAS token valid for 2 days.
  6. Re-read the story doc, then compute proportional per-scene offsets (`computeExactOffsets`): distributes the estimated narration duration across scenes proportionally to each scene's `storySegment` word count (instead of the LLM's rough fixed 15-20s-per-scene estimate), recomputing `startOffsetMs`/`endOffsetMs`/`startTime`/`endTime` for every scene.
  7. Build an SSML document with per-scene `<bookmark>` tags (`buildStorySsmlFromScenes`) from the recomputed scenes and store it on the story's `ssml` field.
  8. Update the corresponding Cosmos DB story document: `scenes` (recomputed offsets), `ssml`, `audio.audioURL`, `audio.status = "completed"`, legacy `audioURL`, and refresh `assetsStatus.audioGenerated`/`imagesGenerated`/`completed`.
- **Note**: OpenAI's `gpt-4o-mini-tts` endpoint accepts plain text only (no SSML input, no bookmark timestamps in the response), so the proportional word-count approach is the practical "exact enough" substitute for now; the stored `ssml` field is ready to be consumed once/if a SSML-capable TTS provider is swapped in.

### `generateImages`

- Trigger: Event Grid event subscription (`generateImages-sub`, filters `StoryCreated`).
- Purpose: fan out one image-generation request per story scene (up to `IMAGES_PER_STORY`, default 6) so they can run in parallel.
- Guarded by `ENABLE_MULTI_SCENE_IMAGES` (default `true`); if `false`, the function is a no-op (no legacy single-image fallback is generated).
- Main steps:
  1. Parse `StoryCreated` event payload; re-read the story doc from Cosmos to get the authoritative `scenes` array (falls back to the event's `scenes` if the doc read comes back empty).
  2. Ensure Blob container exists.
  3. **If an Event Grid client is configured** (`EVENTGRID_TOPIC_ENDPOINT`/`EVENTGRID_KEY` set, the normal deployed path): publish one `SceneImageRequested` event per scene (`storyId`, `sceneNumber`, `imagePrompt`, `characterSheet`) and return immediately — `generateSceneImage` handles each event as its own independent Function invocation, so all scenes generate their images concurrently.
  4. **Fallback** (no Event Grid topic configured, e.g. some local/dev setups): generate images sequentially in-process using the same `generateAndUploadSceneImage`/`updateSceneStatus` helpers from `shared/imageGeneration.ts`, so the pipeline still works end-to-end without parallel fan-out.
  5. **Resilience**: a failed scene (in either path) is marked `status = "failed"` without blocking the story, audio, or other scene images; it can be retried by manually republishing that scene's `SceneImageRequested` event to the Event Grid topic.

### `generateSceneImage` (Fase 3)

- Trigger: Event Grid event subscription (`generateSceneImage-sub`, filters `SceneImageRequested`).
- Purpose: generate and persist a single scene's image; because Azure Functions dispatches each `SceneImageRequested` event to its own invocation, all scenes for a story process **in parallel** instead of one function looping sequentially through all 6.
- Main steps:
  1. Parse the `SceneImageRequested` payload (`storyId`, `sceneNumber`, `imagePrompt`, `characterSheet`).
  2. Ensure Blob container exists.
  3. Call `generateAndUploadSceneImage()` (`shared/imageGeneration.ts`): `openai.images.generate()` (`gpt-image-1`) with the scene's `imagePrompt`, upload to `stories/{id}/images/scene-{sceneNumber}.png`, generate a 2-day SAS URL.
  4. Update the scene's `imageUrl`/`status = "completed"` via `updateSceneStatus()`, which also recomputes `assetsStatus` (`imagesGenerated`, `totalImages`, `completed`).
  5. On failure, mark that scene `status = "failed"` (via `updateSceneStatus`) without affecting other scenes — retry by republishing the same `SceneImageRequested` event.

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
- Purpose: return the full Story Package for frontend rendering.
- Expected input: query param `id`.
- Response: the Story Package (`title`, `story`, `description`, `scenes`, `audio`, `characterSheet`, `assetsStatus`, `estimatedDurationSeconds`) plus legacy `description`/`thumbnail`/`audioURL`, backfilled from the new fields when absent (`story`→`description`, `thumbnail`→`scenes[0].imageUrl`, `audioURL`→`audio.audioURL`), or `404` if not found. Falls back to a mock story if `COSMOS_DB_CONNECTION_STRING` isn't configured.

## Data Model

### Cosmos DB (SQL/Core API, `@azure/cosmos`) containers

- `characters`
  - Stores character definitions used to build story prompts.
- `scenes`
  - Stores scene descriptions used to guide story generation.
- `stories`
  - Fields (Story Package):
    - `id`, `title`, `estimatedDurationSeconds`, `characterSheet` (`name`/`appearance`/`visualConsistencyPrompt`), `story`, `description`, `ttsInstructions`, `scenes` (array of 6: `sceneNumber`, `sceneType`, `sceneTitle`, `sceneDescription`, `storySegment`, `startTime`/`endTime`, `startOffsetMs`/`endOffsetMs`, `imagePrompt`, `imageUrl`, `status`), `audio` (`audioURL`, `durationSeconds`, `status`), `assetsStatus` (`storyGenerated`, `audioGenerated`, `imagesGenerated`, `totalImages`, `completed`), `ssml` (Fase 3, per-scene `<bookmark>` SSML document built by `generateAudio`), `memoryUpdate` (Fase 2, `{ newFriends, newPlaces, newElements }` reported by the LLM for this story)
    - Legacy/compat fields: `characters`, `scene`, `description`, `thumbnail`, `audioURL`, `createdAt`, `ttl` (2 days)
- `childProfiles` (Fase 2)
  - One document per character, keyed by a slugified name (e.g. `"Vega"` -> id `"vega"`).
  - Fields: `id`, `name`, `appearance` (first-established, kept stable across stories), `recurringFriends`/`recurringPlaces`/`recurringElements` (string arrays, capped at 12 most-recent items each), `storyIds` (capped at the last 20), `createdAt`, `updatedAt`.
  - Partition key `/id`; provisioned at 400 RU/s.

## Azure Infrastructure

### `azure/infra/main.bicep`

- Resources defined (all parameterized by `prefix` for full-stack duplication into a new resource group):
  - `Microsoft.Storage/storageAccounts` — Blob Storage for generated assets.
  - `Microsoft.Web/serverfarms` — two App Service Plans: one Linux Consumption (`Y1`) for the Function App, one Linux F1 (free) for the frontend.
  - `Microsoft.Web/sites` — the Function App (`kind: 'functionapp,linux'`, `linuxFxVersion: 'Node|22'`) and the frontend App Service (`kind: 'app,linux'`, `linuxFxVersion: 'NODE|24-lts'`).
  - `Microsoft.DocumentDB/databaseAccounts` + `sqlDatabases`/`containers` — Cosmos DB (SQL/Core API): `characters`, `scenes`, `stories`, and `childProfiles` (Fase 2 persistent character memory); `enableFreeTier` gated by the `cosmosFreeTier` param (only one free-tier account allowed per subscription).
  - `Microsoft.KeyVault/vaults` — optional, gated by `deployKeyVault`.
  - `Microsoft.EventGrid/topics` + 4 `eventSubscriptions` (`generateAudio-sub`, `generateImages-sub`, `notifyStoryCreated-sub` on `StoryCreated`; `generateSceneImage-sub` on `SceneImageRequested`, Fase 3) — gated by `deployEventGridSubscriptions` since the target functions must already exist (two-phase deploy).

### App settings & secrets (Function App)

- `AzureWebJobsStorage`, `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING`, `WEBSITE_CONTENTSHARE`: Function App storage plumbing.
- `SCM_DO_BUILD_DURING_DEPLOYMENT` / `ENABLE_ORYX_BUILD`: both `false` — Linux zip-deploy auto-enables Oryx build by default, which conflicts with `WEBSITE_RUN_FROM_PACKAGE` and breaks the site with `503`s.
- `FUNCTIONS_WORKER_RUNTIME`: `node`
- `FUNCTIONS_EXTENSION_VERSION`: `~4`
- `WEBSITE_RUN_FROM_PACKAGE`: `1`
- `COSMOS_DB_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`
- `EVENTGRID_TOPIC_ENDPOINT`, `EVENTGRID_KEY`
- `ENABLE_AI_GENERATION`, `OPENAI_API_KEY`
- `IMAGES_PER_STORY` (default `6`): max number of scene images `generateImages` generates per story.
- `ENABLE_MULTI_SCENE_IMAGES` (default `true`): master switch for the multi-scene image generation step.
- `WEBSITE_TIME_ZONE`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL_TO`
- `FRONTEND_BASE_URL`: computed as `https://${frontendName}.azurewebsites.net` (plain string, not a `frontendApp.properties.defaultHostName` reference — that would create a circular dependency since the frontend already references the function app's hostname for `API_BASE_URL`).
- `STORIES_DATABASE`, `CHARACTERS_COLLECTION`, `SCENES_COLLECTION`, `STORIES_COLLECTION`, `STORIES_CONTAINER`, `CHILD_PROFILES_COLLECTION`: default to `aiStoriesDb`/`characters`/`scenes`/`stories`/`stories`/`childProfiles` in code if unset.

## Frontend Details

### `azure/frontend`

- `package.json`
  - `next`, `react`, `react-dom`
- Pages:
  - `pages/index.tsx`
    - landing page with a sample story link
  - `pages/story.tsx`
    - `getServerSideProps` fetches `${API_BASE_URL}/api/story?id=...` server-side for the first render (or mock data if `USE_MOCK_DATA=true`, now including 6 mock scenes/`imageUrl`s/`characterSheet`/`audio`/`assetsStatus` for zero-cost UI testing)
    - client-side `useEffect` then polls `/api/story?id=...` (its own proxy route) every 5 seconds, up to 24 attempts, until at least one scene image (or the legacy `thumbnail`) is present
    - `getCurrentScene(scenes, currentTimeSeconds)` helper: returns the scene whose `startOffsetMs`/`endOffsetMs` range contains the audio's current playback time (via the `<audio>` element's `onTimeUpdate`), falling back to the last scene once the audio ends and to the first scene before playback starts
    - renders title, the current scene's image (falling back to the legacy `thumbnail` if no scene images exist yet), scene indicator dots, audio player, and story text (paragraphs split on `\n\n`)
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
