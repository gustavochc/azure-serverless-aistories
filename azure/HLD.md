# High-Level Design (HLD)

## Overview

The Azure version of AI Stories is an event-driven storytelling application that generates bedtime stories (on a schedule or on demand), enriches them with AI-generated audio and images, notifies a recipient by email, and serves them through a web frontend.

See [architecture.svg](./architecture.svg) for the visual diagram and [WORKFLOW.md](./WORKFLOW.md) for a sequence-diagram walkthrough.

## Architecture Summary

- **Frontend**: Next.js application hosted on Azure App Service (Linux, F1 free tier).
- **Backend**: Azure Functions app (Linux Consumption plan) with a scheduled story creation function, an HTTP endpoint for on-demand custom stories, an HTTP API for story retrieval, and three Event Grid-driven functions (audio, image, email notification).
- **Storage**:
  - **Cosmos DB** (SQL/Core API) for story, character, and scene data.
  - **Azure Blob Storage** for generated audio and image assets, served via time-limited SAS URLs.
- **Eventing**: Azure Event Grid to publish and fan out `StoryCreated` events to 3 independent subscribers.
- **AI**: OpenAI API for text generation (`gpt-4o-mini`), image generation (`gpt-image-1`), and speech synthesis (`gpt-4o-mini-tts`).
- **Notifications**: SMTP (via `nodemailer`) sends an email with a link to the new story as soon as it's created.
- **Secrets/config**: Azure Key Vault (optional) and Function app settings for API keys, connection strings, and the frontend's public hostname (`FRONTEND_BASE_URL`).

## Primary Data Flows

1. **Story Creation**
   - Either a timer-triggered Azure Function (`createStory`, uses all seeded characters + a random scene) or an HTTP-triggered function (`createCustomStory`, caller-supplied characters/theme, function-key protected) runs.
   - It calls OpenAI to generate a story title and body.
   - It stores the new story in Cosmos DB with a 2-day TTL (`ttl: 172800`).
   - It publishes a `StoryCreated` event to Event Grid and (for `createCustomStory`) returns `202 Accepted` with the new story's `id` immediately.

2. **Asset Generation & Notification**
   - Event Grid routes the `StoryCreated` event to three subscribers, all running concurrently:
     - `generateAudio`: generates speech audio (`gpt-4o-mini-tts`) and uploads it to Blob Storage.
     - `generateImages`: generates an image (`gpt-image-1`, using the story's `scene`/theme text verbatim as the prompt) and uploads it to Blob Storage.
     - `notifyStoryCreated`: emails `NOTIFY_EMAIL_TO` via SMTP with a link built from `FRONTEND_BASE_URL`.
   - `generateAudio`/`generateImages` each update the story document in Cosmos DB with a SAS-signed asset URL (`audioURL`/`thumbnail`).

3. **Story Presentation**
   - The frontend requests story data through its own `/api/story` proxy, which calls the `getStory` HTTP function.
   - Because asset generation is asynchronous, the frontend renders the story text immediately and client-side polls `/api/story` every 5 seconds (up to 24 attempts) until the thumbnail appears, then renders the audio player and thumbnail image too.

## Key Components

- `azure/infra/main.bicep`
  - Deploys Storage Account, App Service Plans (function app + frontend, both Linux), Function App, Cosmos DB, Event Grid Topic + 3 subscriptions, frontend App Service, and Key Vault. Parameterized by `prefix` so the whole stack can be duplicated into a new resource group.
- `azure/function-app`
  - `createStory`: timer-triggered story generation (all seeded characters, random scene)
  - `createCustomStory`: HTTP-triggered on-demand story generation (custom characters/theme)
  - `generateAudio`: Event Grid-triggered TTS generation
  - `generateImages`: Event Grid-triggered image generation
  - `notifyStoryCreated`: Event Grid-triggered email notification
  - `getStory`: HTTP endpoint for story retrieval
- `azure/frontend`
  - Next.js pages for story display, an `/api/story` proxy, and client-side polling for asset readiness

## Non-functional Considerations

- **Scalability**: Azure Functions scale automatically for event-driven workloads.
- **Performance**: Cosmos DB provides low-latency reads for story retrieval.
- **Resilience**: Event Grid decouples story creation from asset generation and notification; a failure in one subscriber doesn't block the others.
- **Security**: secrets are stored in app settings and (optionally) Key Vault; storage blobs are accessed through time-limited SAS URLs; `createCustomStory` requires a function key since it triggers billed OpenAI calls.
- **Extensibility**: The design supports additional event subscribers (e.g. analytics, push notifications) alongside the existing audio/image/email subscribers.
- **Known gotcha**: Azure permanently ties a resource group + region to one OS type for Dynamic SKU Function App plans. Migrating hosting OS (e.g. Windows -> Linux) requires a brand-new resource group, not an in-place conversion.

## Deployment Notes

- Infrastructure is provisioned through Bicep, in two phases if deploying from scratch (`deployEventGridSubscriptions=false` then `=true` — see `azure/infra/README.md`).
- Azure Function configuration is provided through app settings at deployment time; the `appSettings` array in bicep replaces rather than merges, so settings changed outside of bicep are lost on redeploy.
- Frontend is deployed separately and configured to use the backend API URL via `API_BASE_URL`.
