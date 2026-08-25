# Cost Analysis for AI Stories (Development / Testing Phase)

## Goal

Keep the application as cheap as possible during development and testing while still allowing local UI validation and optional Azure-based testing.

## Recommended lowest-cost setup

- Frontend: local development with mock data, or Azure App Service Linux F1 (free tier) if you want a public preview
- Backend: Azure Functions Consumption plan (Linux)
- Database: Cosmos DB free tier
- Storage: Azure Storage Standard LRS
- Eventing: Event Grid only when needed
- Notifications: SMTP via a free Gmail account (no extra cost)
- Secrets: skip Key Vault during early development unless required

## Why this is cheap

The main cost drivers in this app are:

1. Azure hosting
2. Cosmos DB usage
3. Storage for generated assets
4. OpenAI API calls for story, image (`gpt-image-1`), and audio generation

Each story now generates a **Story Package** with 6 scene images instead of 1 (`IMAGES_PER_STORY`, default `6`), so `gpt-image-1` cost per story is up to 6x what it was before. Lower `IMAGES_PER_STORY` (e.g. `1`-`2`) during testing, or set `ENABLE_MULTI_SCENE_IMAGES=false` to skip image generation entirely, to control this.

Email notifications (SMTP via a free Gmail account) add no meaningful cost.

**Fase 2/3 cost impact**: the `childProfiles` container (persistent character memory) adds one small Cosmos container at 400 RU/s — negligible, and covered by the free-tier RU/s pool if `cosmosFreeTier=true`. Fase 3's parallel scene-image generation (`SceneImageRequested` fan-out to `generateSceneImage`) doesn't change the total number of `gpt-image-1` calls per story (still up to `IMAGES_PER_STORY`) — it only parallelizes them across separate Function invocations, so total OpenAI cost per story is unchanged, just faster wall-clock time. Running many scenes concurrently can occasionally hit transient OpenAI rate limits under load; a failed scene is isolated (marked `status: "failed"`) and can be retried by republishing its event at no cost to the other scenes.

The configuration now minimizes these by:

- keeping AI generation disabled by default
- using a near-disabled timer schedule
- using mock data for frontend testing
- keeping the infrastructure lightweight

## Current cost controls implemented

The repo now includes these safeguards:

- `ENABLE_AI_GENERATION=false` by default in the Azure Functions app
- a very sparse timer schedule for the story creation trigger
- mock data support in the frontend so the UI can be tested without Azure or AI calls
- optional Key Vault disabled by default

## Expected cost profile

### Local development only

- Frontend: $0
- Backend: $0
- Cosmos DB: $0 or very low
- OpenAI: $0 if AI is not enabled

### Light Azure test run

- Functions: usually near $0 for low usage on Consumption
- Storage: very low
- Cosmos DB: low or free-tier eligible
- OpenAI: only when you explicitly enable AI generation

## Recommended usage pattern

Use this pattern during development:

1. Run the frontend locally with mock data.
2. Keep Azure resources deployed only if you want a quick test.
3. Avoid enabling AI generation unless you are intentionally testing the paid flow.
4. Use manual or very infrequent triggers.

## Environment flags

Set these in the app settings when needed:

- `ENABLE_AI_GENERATION=true` to enable paid AI runs
- `USE_MOCK_DATA=true` to keep the frontend in local mock mode
- `IMAGES_PER_STORY` (default `6`) to control how many of the 6 scenes get an image generated per story
- `ENABLE_MULTI_SCENE_IMAGES=false` to disable image generation entirely while testing the story/audio flow

## Summary

For a development/testing phase, the cheapest practical setup is:

- local frontend + mock data
- Azure Functions Consumption (Linux)
- Cosmos DB free tier (only one free-tier account allowed per subscription — use `cosmosFreeTier=false` for additional stacks)
- no Key Vault unless needed
- AI generation disabled until explicitly required
