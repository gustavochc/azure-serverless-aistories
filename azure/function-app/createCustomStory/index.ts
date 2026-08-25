import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import OpenAI from 'openai';
import { EventGridPublisherClient, AzureKeyCredential } from '@azure/eventgrid';
import { buildBedtimePrompt, safeParseStoryPackage } from '../shared/storyPrompt';
import { loadChildProfiles, buildMemoryContext, upsertChildProfiles } from '../shared/childProfile';
import { StoryCreatedEventData } from '../shared/types';

const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const scenesContainer = database.container(process.env.SCENES_COLLECTION || 'scenes');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');
const childProfilesContainer = database.container(process.env.CHILD_PROFILES_COLLECTION || 'childProfiles');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const eventGridEndpoint = process.env.EVENTGRID_TOPIC_ENDPOINT || '';
const eventGridKey = process.env.EVENTGRID_KEY || '';
const eventGridClient = eventGridEndpoint && eventGridKey ? new EventGridPublisherClient(eventGridEndpoint, 'EventGrid', new AzureKeyCredential(eventGridKey)) : null;
const aiGenerationEnabled = (process.env.ENABLE_AI_GENERATION || 'false').toLowerCase() === 'true';

const MAX_CHARACTERS = 4;

export async function createCustomStory(req: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (!aiGenerationEnabled) {
    return { status: 503, jsonBody: { error: 'AI generation is disabled. Set ENABLE_AI_GENERATION=true to enable paid runs.' } };
  }

  const body: any = await req.json().catch(() => ({}));
  const requestedNames: unknown = body?.characters;
  const names = Array.isArray(requestedNames)
    ? requestedNames.map((n) => String(n).trim()).filter(Boolean).slice(0, MAX_CHARACTERS)
    : [];

  if (!names.length) {
    return { status: 400, jsonBody: { error: 'Provide a "characters" array with at least one character name.' } };
  }

  let theme = typeof body?.theme === 'string' ? body.theme.trim() : '';
  if (!theme) {
    const { resources: scenes } = await scenesContainer.items.readAll().fetchAll();
    if (!scenes.length) {
      return { status: 400, jsonBody: { error: 'Provide a "theme" — no default scenes are seeded to fall back on.' } };
    }
    theme = scenes[Math.floor(Math.random() * scenes.length)].description;
  }

  const characters = names.map((name, idx) => ({ id: String(idx + 1), name }));

  const memoryProfiles = await loadChildProfiles(childProfilesContainer, names).catch(() => []);
  const memoryContext = buildMemoryContext(memoryProfiles);
  const prompt = buildBedtimePrompt(names, theme, memoryContext);

  const result = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 3000,
    temperature: 0.7,
  });

  const raw = result.choices[0]?.message?.content?.trim() || '';
  const storyPackage = safeParseStoryPackage(raw, names.join(' and '));

  const createResponse = await storiesContainer.items.create({
    id: crypto.randomUUID(),
    ...storyPackage,
    characters,
    scene: theme,
    // Legacy fields kept for backwards compatibility with the current frontend/model.
    description: storyPackage.description,
    thumbnail: '',
    audioURL: '',
    createdAt: new Date().toISOString(),
    ttl: 172800,
  });

  const story = createResponse.resource;

  if (!story) {
    return { status: 500, jsonBody: { error: 'Failed to create story.' } };
  }

  await upsertChildProfiles(childProfilesContainer, names, story.id, story.characterSheet?.appearance || '', story.memoryUpdate).catch((error) => {
    _context.error('Failed to update child profiles (non-fatal)', error);
  });

  if (eventGridClient) {
    const eventData: StoryCreatedEventData = {
      id: story.id,
      title: story.title,
      story: story.story,
      description: story.description,
      scenes: story.scenes,
      characterSheet: story.characterSheet,
      estimatedDurationSeconds: story.estimatedDurationSeconds,
    };
    await eventGridClient.send([
      {
        eventType: 'StoryCreated',
        subject: `/stories/${story.id}`,
        dataVersion: '1.0',
        data: eventData,
      },
    ]);
  }

  return {
    status: 202,
    jsonBody: {
      id: story.id,
      title: story.title,
      message: `Story created. Audio and image are generating asynchronously — check GET /api/story?id=${story.id} shortly.`,
    },
  };
}

app.http('createCustomStory', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'createCustomStory',
  handler: createCustomStory,
});
