import { app, InvocationContext, Timer } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import OpenAI from 'openai';
import { EventGridPublisherClient, AzureKeyCredential } from '@azure/eventgrid';
import { buildBedtimePrompt, safeParseStoryPackage } from '../shared/storyPrompt';
import { loadChildProfiles, buildMemoryContext, upsertChildProfiles } from '../shared/childProfile';
import { StoryCreatedEventData } from '../shared/types';

const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const charactersContainer = database.container(process.env.CHARACTERS_COLLECTION || 'characters');
const scenesContainer = database.container(process.env.SCENES_COLLECTION || 'scenes');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');
const childProfilesContainer = database.container(process.env.CHILD_PROFILES_COLLECTION || 'childProfiles');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const eventGridEndpoint = process.env.EVENTGRID_TOPIC_ENDPOINT || '';
const eventGridKey = process.env.EVENTGRID_KEY || '';
const eventGridClient = eventGridEndpoint && eventGridKey ? new EventGridPublisherClient(eventGridEndpoint, 'EventGrid', new AzureKeyCredential(eventGridKey)) : null;
const aiGenerationEnabled = (process.env.ENABLE_AI_GENERATION || 'false').toLowerCase() === 'true';

export async function createStory(_myTimer: Timer, context: InvocationContext): Promise<void> {
  if (!aiGenerationEnabled) {
    context.log('AI generation is disabled. Set ENABLE_AI_GENERATION=true to enable paid runs.');
    return;
  }

  const { resources: characters } = await charactersContainer.items.readAll().fetchAll();
  const { resources: scenes } = await scenesContainer.items.readAll().fetchAll();

  if (!characters.length || !scenes.length) {
    context.log('No characters or scenes found.');
    return;
  }

  const selectedScene = scenes[Math.floor(Math.random() * scenes.length)];
  const names = characters.map((c: any) => c.name);

  const memoryProfiles = await loadChildProfiles(childProfilesContainer, names).catch(() => []);
  const memoryContext = buildMemoryContext(memoryProfiles);
  const prompt = buildBedtimePrompt(names, selectedScene.description, memoryContext);

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
    scene: selectedScene.description,
    // Legacy fields kept for backwards compatibility with the current frontend/model.
    description: storyPackage.description,
    thumbnail: '',
    audioURL: '',
    createdAt: new Date().toISOString(),
    ttl: 172800,
  });

  const story = createResponse.resource;

  if (story) {
    await upsertChildProfiles(childProfilesContainer, names, story.id, story.characterSheet?.appearance || '', story.memoryUpdate).catch((error) => {
      context.error('Failed to update child profiles (non-fatal)', error);
    });
  }

  if (eventGridClient && story) {
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
}

app.timer('createStory', {
  schedule: '0 0 20 * * *',
  handler: createStory,
});
