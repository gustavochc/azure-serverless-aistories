import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import OpenAI from 'openai';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { EventGridPublisherClient, AzureKeyCredential } from '@azure/eventgrid';
import { generateAndUploadSceneImage, updateSceneStatus } from '../shared/imageGeneration';
import { SceneImageRequestedEventData, StoryCreatedEventData, StoryScene } from '../shared/types';

const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
const blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobService.getContainerClient(process.env.STORIES_CONTAINER || 'stories');

const imagesPerStory = Number(process.env.IMAGES_PER_STORY || 6);
const multiSceneImagesEnabled = (process.env.ENABLE_MULTI_SCENE_IMAGES || 'true').toLowerCase() === 'true';

const eventGridEndpoint = process.env.EVENTGRID_TOPIC_ENDPOINT || '';
const eventGridKey = process.env.EVENTGRID_KEY || '';
const eventGridClient = eventGridEndpoint && eventGridKey ? new EventGridPublisherClient(eventGridEndpoint, 'EventGrid', new AzureKeyCredential(eventGridKey)) : null;

const eventGridTrigger = async function (eventGridEvent: EventGridEvent, context: InvocationContext): Promise<void> {
  const detail = eventGridEvent?.data as unknown as StoryCreatedEventData;
  if (!detail?.id) {
    context.log('Invalid event payload');
    return;
  }

  await containerClient.createIfNotExists();

  if (!multiSceneImagesEnabled) {
    context.log('ENABLE_MULTI_SCENE_IMAGES is false; skipping multi-scene image generation.');
    return;
  }

  const { resource: story } = await storiesContainer.item(detail.id, detail.id).read();
  const scenes: StoryScene[] = Array.isArray(story?.scenes) && story.scenes.length ? story.scenes : detail.scenes || [];

  if (!scenes.length) {
    context.log('No scenes found for story, skipping image generation.');
    return;
  }

  const scenesToGenerate = scenes.slice(0, imagesPerStory);

  // Phase 3: fan out one SceneImageRequested event per scene so generateSceneImage can
  // process them in parallel (independent Function invocations) instead of looping here.
  if (eventGridClient) {
    await eventGridClient.send(
      scenesToGenerate.map((scene) => ({
        eventType: 'SceneImageRequested',
        subject: `/stories/${detail.id}/scenes/${scene.sceneNumber}`,
        dataVersion: '1.0',
        data: {
          storyId: detail.id,
          sceneNumber: scene.sceneNumber,
          imagePrompt: scene.imagePrompt || detail.description || detail.title,
          characterSheet: detail.characterSheet,
        } satisfies SceneImageRequestedEventData,
      }))
    );
    return;
  }

  // Fallback for local/dev environments without an Event Grid topic configured (no
  // EVENTGRID_TOPIC_ENDPOINT/KEY): generate sequentially in-process so the pipeline still
  // works end-to-end without parallel fan-out.
  context.log('EVENTGRID_TOPIC_ENDPOINT/KEY not configured; generating scene images sequentially in-process.');
  for (const scene of scenesToGenerate) {
    try {
      const prompt = scene.imagePrompt || detail.description || detail.title;
      const imageUrl = await generateAndUploadSceneImage(openai, containerClient, sharedKeyCredential, detail.id, scene.sceneNumber, prompt);
      await updateSceneStatus(storiesContainer, detail.id, scene.sceneNumber, { imageUrl, status: 'completed' });
    } catch (error) {
      context.error(`Failed to generate image for scene ${scene.sceneNumber}`, error);
      await updateSceneStatus(storiesContainer, detail.id, scene.sceneNumber, { status: 'failed' }).catch((updateError) => {
        context.error(`Failed to mark scene ${scene.sceneNumber} as failed`, updateError);
      });
    }
  }
};

app.eventGrid('generateImages', {
  handler: eventGridTrigger,
});

