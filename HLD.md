# High-Level Design (HLD)

## Overview

The Azure version of AI Stories is an event-driven storytelling application that generates a complete **Story Package** (short bedtime story + narrated audio + 6 synchronized visual scenes) on a schedule or on demand, notifies a recipient by email, and serves them through a web frontend that plays the scene images back in sync with the audio.

See [architecture.svg](./architecture.svg) for the visual diagram and [WORKFLOW.md](./WORKFLOW.md) for a sequence-diagram walkthrough.

## Architecture Summary

- **Frontend**: Next.js application hosted on Azure App Service (Linux, F1 free tier).
- **Backend**: Azure Functions app (Linux Consumption plan) with a scheduled story creation function, an HTTP endpoint for on-demand custom stories, an HTTP API for story retrieval, and Event Grid-driven functions for audio, per-scene images, and email notification.
- **Storage**:
  - **Cosmos DB** (SQL/Core API) for story, character, scene, and `childProfiles` (persistent per-character memory) data.
  - **Azure Blob Storage** for generated audio and image assets, served via time-limited SAS URLs.
- **Eventing**: Azure Event Grid to publish and fan out `StoryCreated` events to 3 independent subscribers, plus a per-scene `SceneImageRequested` event that fans out image generation in parallel.
- **AI**: OpenAI API for text generation (`gpt-4o-mini`), image generation (`gpt-image-1`), and speech synthesis (`gpt-4o-mini-tts`).
- **Notifications**: SMTP (via `nodemailer`) sends an email with a link to the new story as soon as it's created.
- **Secrets/config**: Azure Key Vault (optional) and Function app settings for API keys, connection strings, and the frontend's public hostname (`FRONTEND_BASE_URL`).

## Primary Data Flows

1. **Story Package Creation**
   - Either a timer-triggered Azure Function (`createStory`, uses all seeded characters + a random scene) or an HTTP-triggered function (`createCustomStory`, caller-supplied characters/theme, function-key protected) runs.
   - Before prompting the LLM, it loads each named character's `childProfiles` document from Cosmos (`shared/childProfile.ts`'s `loadChildProfiles`) and builds a Spanish-language memory block (`buildMemoryContext`) listing recurring friends, places, magical elements, and the established `appearance` — giving the same character continuity across many stories instead of a blank slate each time.
   - It calls OpenAI to generate a complete **Story Package** as strict JSON: title, full story text, a fixed `characterSheet` (for visual consistency), `ttsInstructions`, exactly 6 `scenes` (cover, introduction, discovery, adventure, magicalMoment, sleepEnding) each with its own `imagePrompt` and estimated `startTime`/`endTime`/`startOffsetMs`/`endOffsetMs`, and a `memoryUpdate` field reporting any new friends/places/elements introduced in this story. `shared/storyPrompt.ts`'s `safeParseStoryPackage()` sanitizes/validates the LLM response (strips markdown fences, guarantees 6 scenes, fills defaults).
   - It stores the Story Package in Cosmos DB with a 2-day TTL (`ttl: 172800`), keeping legacy top-level fields (`description`, `thumbnail`, `audioURL`) for backwards compatibility, then merges `memoryUpdate` into each character's `childProfiles` document (`upsertChildProfiles`, capped at 12 items per list / 20 story IDs) — this is non-fatal and never blocks story creation.
   - It publishes a `StoryCreated` event to Event Grid (now carrying `story`, `description`, `scenes`, `characterSheet`, `estimatedDurationSeconds`) and (for `createCustomStory`) returns `202 Accepted` with the new story's `id` immediately.

2. **Asset Generation & Notification**
   - Event Grid routes the `StoryCreated` event to three subscribers, all running concurrently:
     - `generateAudio`: generates speech audio (`gpt-4o-mini-tts`) for the full story text, uploads it to Blob Storage, then computes proportional per-scene offsets (`computeExactOffsets`, based on each scene's narration word count relative to the actual synthesized duration) and builds an SSML document with per-scene `<bookmark>` tags (`buildStorySsmlFromScenes`), stored on the story's `ssml` field for a future SSML-capable TTS provider.
     - `generateImages`: reads the story's 6 `scenes` (up to `IMAGES_PER_STORY`, default 6) and publishes one `SceneImageRequested` event per scene to Event Grid instead of generating images itself.
     - `notifyStoryCreated`: emails `NOTIFY_EMAIL_TO` via SMTP with a link built from `FRONTEND_BASE_URL`.
   - A fourth subscriber, `generateSceneImage`, handles each `SceneImageRequested` event as an independent Function invocation — generating one image (`gpt-image-1`, using that scene's tailored `imagePrompt`) uploaded to Blob Storage at `stories/{id}/images/scene-{n}.png`. Because Azure Functions dispatches each event separately, all (up to 6) scene images generate **in parallel** rather than in a sequential loop. A failure on one scene is caught and marks that scene `failed` without blocking the rest of the story, the audio, or the other scenes — it can be retried by republishing that scene's `SceneImageRequested` event.
   - `generateAudio` updates `audio.audioURL`/`audio.status` (plus legacy `audioURL`) and the recomputed `scenes[n].startOffsetMs`/`endOffsetMs`; `generateSceneImage` updates each `scenes[n].imageUrl`/`status` and `assetsStatus` (`imagesGenerated`, `totalImages`, `completed`).

3. **Story Presentation**
   - The frontend requests story data through its own `/api/story` proxy, which calls the `getStory` HTTP function (returns the full Story Package: `scenes`, `audio`, `characterSheet`, `assetsStatus`, plus legacy fields).
   - Because asset generation is asynchronous, the frontend renders the story text immediately and client-side polls `/api/story` every 5 seconds (up to 24 attempts) until at least one scene image (or the legacy thumbnail) appears.
   - While the audio plays, the frontend tracks `currentTime` and picks the scene whose `startOffsetMs`/`endOffsetMs` range contains it (`getCurrentScene` helper), swapping the displayed image automatically; it stays on the last scene once the audio ends, and falls back to the legacy `thumbnail` if no scene images are available yet.

## Key Components

- `azure/infra/main.bicep`
  - Deploys Storage Account, App Service Plans (function app + frontend, both Linux), Function App, Cosmos DB (including the `childProfiles` container), Event Grid Topic + 4 subscriptions, frontend App Service, and Key Vault. Parameterized by `prefix` so the whole stack can be duplicated into a new resource group.
- `azure/function-app`
  - `createStory`: timer-triggered Story Package generation (all seeded characters, random scene)
  - `createCustomStory`: HTTP-triggered on-demand Story Package generation (custom characters/theme)
  - `generateAudio`: Event Grid-triggered TTS generation for the full story, plus exact offset computation and SSML generation
  - `generateImages`: Event Grid-triggered; fans out one `SceneImageRequested` event per scene (up to 6)
  - `generateSceneImage`: Event Grid-triggered; generates a single scene's image (parallel, one invocation per scene)
  - `notifyStoryCreated`: Event Grid-triggered email notification
  - `getStory`: HTTP endpoint for Story Package retrieval
  - `shared/types.ts`: shared `StoryPackage`/`StoryScene`/`CharacterSheet`/`ChildProfile`/`MemoryUpdate`/`SceneImageRequestedEventData`/etc. TypeScript contract
  - `shared/storyPrompt.ts`: prompt builder (accepts a `memoryContext` block) + `safeParseStoryPackage` JSON sanitizer + `buildStorySsmlFromScenes`
  - `shared/childProfile.ts`: persistent per-character memory — `loadChildProfiles`, `buildMemoryContext`, `upsertChildProfiles`
  - `shared/imageGeneration.ts`: shared single-scene image generation/upload logic used by both `generateImages` (fallback, no Event Grid configured) and `generateSceneImage`
- `azure/frontend`
  - Next.js pages for story display, an `/api/story` proxy, and client-side polling + scene-synced playback (`getCurrentScene` helper)

## Non-functional Considerations

- **Scalability**: Azure Functions scale automatically for event-driven workloads.
- **Performance**: Cosmos DB provides low-latency reads for story retrieval.
- **Resilience**: Event Grid decouples story creation from asset generation and notification; a failure in one subscriber doesn't block the others.
- **Security**: secrets are stored in app settings and (optionally) Key Vault; storage blobs are accessed through time-limited SAS URLs; `createCustomStory` requires a function key since it triggers billed OpenAI calls.
- **Extensibility**: The design supports additional event subscribers (e.g. analytics, push notifications) alongside the existing audio/image/email subscribers.
- **Known gotcha**: Azure permanently ties a resource group + region to one OS type for Dynamic SKU Function App plans. Migrating hosting OS (e.g. Windows -> Linux) requires a brand-new resource group, not an in-place conversion.

## Roadmap

- **Fase 1** (implemented): the Story Package model — title, full story text, 6 fixed scenes, characterSheet, ttsInstructions.
- **Fase 2** (implemented): `childProfiles` container in Cosmos DB for persistent character memory (recurring friends, places, and elements across stories for the same child), injected into the story prompt and updated via the LLM's `memoryUpdate` response.
- **Fase 3** (implemented): proportional per-scene audio offsets (`computeExactOffsets`) computed from actual narration duration instead of the LLM's rough estimate, SSML bookmarks generated and stored (`ssml` field) for a future SSML-capable TTS provider, and a `SceneImageRequested` event per scene so `generateSceneImage` generates all (up to 6) images in parallel instead of sequentially.
- **Not yet implemented**: automatic retry for failed scene images (currently requires manually republishing the `SceneImageRequested` event); wiring an SSML-capable TTS provider (e.g. Azure Speech) to consume the stored `ssml` bookmarks directly instead of the proportional-offset approximation.

## Deployment Notes

- Infrastructure is provisioned through Bicep, in two phases if deploying from scratch (`deployEventGridSubscriptions=false` then `=true` — see `azure/infra/README.md`).
- Azure Function configuration is provided through app settings at deployment time; the `appSettings` array in bicep replaces rather than merges, so settings changed outside of bicep are lost on redeploy.
- Frontend is deployed separately and configured to use the backend API URL via `API_BASE_URL`.
