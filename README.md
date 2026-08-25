# Azure AI Stories

This app has been created in Azure with the following structure:

- `azure/infra` - Azure Bicep deployment for Storage, App Service (Linux, function app + frontend), Cosmos DB, Event Grid, and Key Vault.
- `azure/function-app` - Azure Functions app for **Story Package** generation (scheduled + on-demand), audio generation, multi-scene image generation, story retrieval, and email notification.
- `azure/frontend` - Next.js frontend (polls for audio/image assets, then plays back the 6 scene images in sync with the audio timeline).
- `azure/architecture.svg` - Visual architecture diagram for the Azure deployment.
- `azure/WORKFLOW.md` - Sequence/flow diagram of the end-to-end story creation -> asset generation -> notification -> rendering flow.

### Story Package (Fase 1)

Each story is now a **Story Package**: a short Spanish bedtime story (~250-450 words, ~90-120s narrated) split into 6 fixed scenes (`cover`, `introduction`, `discovery`, `adventure`, `magicalMoment`, `sleepEnding`), each with its own image prompt, generated image, and estimated `startOffsetMs`/`endOffsetMs` for frontend sync. Legacy top-level fields (`description`, `thumbnail`, `audioURL`) are still populated for backwards compatibility. See `shared/types.ts` for the full contract and [HLD.md](HLD.md)/[LLD.md](LLD.md) for details.

### Persistent character memory (Fase 2)

Each character (matched by a slugified name, e.g. "Vega" -> `vega`) has a `childProfiles` Cosmos document tracking recurring friends, places, and magical elements across stories, plus the established `appearance` and the list of story IDs it appeared in. Before generating a new story, `createStory`/`createCustomStory` load these profiles and inject a Spanish-language memory block into the prompt so the LLM can bring back familiar friends/places instead of starting from a blank slate every time. The LLM reports any new friends/places/elements introduced via a `memoryUpdate` field in its JSON response, which is merged back into the profile (capped at the last 12 items per list, 20 story IDs) after the story is created. See `shared/childProfile.ts`.

### Exact audio offsets + parallel scene images (Fase 3)

`generateAudio` now computes proportional per-scene offsets (`computeExactOffsets`) based on each scene's narration word count relative to the synthesized audio duration, instead of the LLM's rough 15-20s estimate — giving tighter image/audio sync. It also builds and stores an SSML document with per-scene `<bookmark>` tags (`buildStorySsmlFromScenes`) on the story's `ssml` field, ready for a future SSML-capable TTS provider. Scene image generation is now parallel: `generateImages` publishes one `SceneImageRequested` event per scene to Event Grid, and the new `generateSceneImage` function processes each event as an independent Function invocation — so all (up to 6) scene images generate concurrently instead of in a sequential loop. A per-scene failure only marks that scene `failed` and can be retried by republishing its `SceneImageRequested` event, without affecting the others.

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

3. Configure Azure Function app settings for `OPENAI_API_KEY`, `COSMOS_DB_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, `EVENTGRID_TOPIC_ENDPOINT`, `EVENTGRID_KEY`, `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, `NOTIFY_EMAIL_TO`, `FRONTEND_BASE_URL`, `IMAGES_PER_STORY` (default `6`), `ENABLE_MULTI_SCENE_IMAGES` (default `true`), and container names. Most of these are already set by `main.bicep` on every deploy — see `azure/infra/README.md`.

4. Deploy the function app from `azure/function-app`.

5. Deploy the frontend to Azure App Service (Linux) or keep it local while you develop.

### Cost-saving tips

- Keep the timer trigger disabled or set it to a very sparse schedule.
- Avoid generating audio and images on every run.
- Use manual triggering and local development for most work.
- Skip Key Vault during early testing unless you need it.
- Set `USE_MOCK_DATA=true` to keep the frontend fully free during development.
- Set `ENABLE_AI_GENERATION=false` unless you explicitly want to pay for AI calls.
- Each story now generates up to 6 images instead of 1 — lower `IMAGES_PER_STORY` (e.g. `1` or `2`) while testing to reduce `gpt-image-1` cost, or set `ENABLE_MULTI_SCENE_IMAGES=false` to fall back to no image generation at all.
