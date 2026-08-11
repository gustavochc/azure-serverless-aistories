# App Workflow

This describes the end-to-end request/event flow for the Azure version of AI Stories, from story creation through frontend rendering and email notification.

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant FE as Frontend (Next.js)
    participant API as createStory / createCustomStory
    participant Cosmos as Cosmos DB
    participant EG as Event Grid (StoryCreated)
    participant Audio as generateAudio
    participant Image as generateImages
    participant Notify as notifyStoryCreated
    participant OpenAI as OpenAI API
    participant Blob as Blob Storage
    participant SMTP as SMTP (Gmail)

    alt Scheduled story
        API->>API: Timer trigger fires (createStory)
    else Custom story
        User->>API: POST /api/createCustomStory {characters, theme}
    end
    API->>OpenAI: Chat completion (gpt-4o-mini)
    OpenAI-->>API: story title + description
    API->>Cosmos: create story doc (ttl 172800 = 2 days)
    API->>EG: publish StoryCreated {id, title, description, scene}
    API-->>User: 202 Accepted {id, title}

    par Audio generation
        EG->>Audio: StoryCreated event
        Audio->>OpenAI: TTS request (gpt-4o-mini-tts)
        OpenAI-->>Audio: audio bytes
        Audio->>Blob: upload stories/{id}/audio.mp3
        Audio->>Cosmos: update audioURL (SAS, 2-day expiry)
    and Image generation
        EG->>Image: StoryCreated event
        Image->>OpenAI: image request (gpt-image-1, prompt = scene)
        OpenAI-->>Image: image bytes
        Image->>Blob: upload stories/{id}/image.png
        Image->>Cosmos: update thumbnail (SAS, 2-day expiry)
    and Email notification
        EG->>Notify: StoryCreated event
        Notify->>SMTP: send email (nodemailer) to NOTIFY_EMAIL_TO
        Note over Notify,SMTP: Link uses FRONTEND_BASE_URL + /story?id=...
    end

    User->>FE: open /story?id=...
    FE->>API: GET /api/story?id=... (proxied to getStory)
    API->>Cosmos: read story doc
    Cosmos-->>API: story (may lack audioURL/thumbnail yet)
    API-->>FE: story JSON
    loop until thumbnail present (max 24 attempts, every 5s)
        FE->>API: GET /api/story?id=...
        API->>Cosmos: read story doc
        Cosmos-->>API: story
        API-->>FE: story JSON
    end
    FE-->>User: render title, audio player, thumbnail, story text
```

## Flowchart view

```mermaid
flowchart LR
    subgraph Creation
        Timer[Timer trigger] --> createStory
        HTTPReq[HTTP request] --> createCustomStory
        createStory --> OpenAIText[OpenAI gpt-4o-mini]
        createCustomStory --> OpenAIText
        OpenAIText --> SaveStory[Save story to Cosmos DB]
        SaveStory --> Publish[Publish StoryCreated to Event Grid]
    end

    subgraph "Parallel asset generation (Event Grid fan-out)"
        Publish --> generateAudio
        Publish --> generateImages
        Publish --> notifyStoryCreated
        generateAudio --> TTS[OpenAI gpt-4o-mini-tts] --> AudioBlob[Blob: audio.mp3] --> UpdateAudio[Update audioURL in Cosmos]
        generateImages --> ImageGen[OpenAI gpt-image-1] --> ImageBlob[Blob: image.png] --> UpdateThumb[Update thumbnail in Cosmos]
        notifyStoryCreated --> Email[Send email via SMTP/nodemailer]
    end

    subgraph Presentation
        UserBrowser[User opens /story?id=] --> Frontend[Next.js frontend]
        Frontend --> getStory
        getStory --> ReadCosmos[Read story from Cosmos DB]
        ReadCosmos --> Frontend
        Frontend -- "poll every 5s until thumbnail" --> getStory
        Frontend --> Render[Render title, audio, image, text]
    end

    Email -. "clicks link to" .-> UserBrowser
```

## Notes

- **Two ways to create a story**: the nightly `createStory` timer (uses all seeded characters + a random scene) or the on-demand `createCustomStory` HTTP endpoint (caller-supplied characters/theme, function-key protected since it costs real OpenAI calls).
- **Event Grid fan-out is 3-way**, not 2-way: `generateAudio`, `generateImages`, and `notifyStoryCreated` all subscribe independently to the same `StoryCreated` event and run concurrently.
- **Read-after-write race**: because asset generation is asynchronous, a user opening the story link right away may see text only. The frontend's `/api/story` proxy is polled client-side (every 5s, up to 24 attempts ≈ 2 minutes) until the thumbnail appears — this is what fixed the earlier "image never shows up" symptom.
- **Email link correctness**: `notifyStoryCreated` builds the story link from the `FRONTEND_BASE_URL` app setting — this must match the actual deployed frontend hostname for the given `prefix`/resource group (see [main.bicep](infra/main.bicep)).
- **TTL cleanup**: story documents in Cosmos DB have `ttl: 172800` (2 days), after which Cosmos automatically deletes them — matching the SAS token expiry on the blob assets.
