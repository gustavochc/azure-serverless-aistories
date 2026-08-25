import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import OpenAI from 'openai';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { generateAndUploadSceneImage, updateSceneStatus } from '../shared/imageGeneration';
import { SceneImageRequestedEventData } from '../shared/types';

const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
const blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobService.getContainerClient(process.env.STORIES_CONTAINER || 'stories');

// Phase 3: handles a single SceneImageRequested event (one per scene, published by
// generateImages). Azure Functions dispatches each event to its own independent invocation,
// so all scenes for a story generate their images in parallel instead of a sequential loop.
const eventGridTrigger = async function (eventGridEvent: EventGridEvent, context: InvocationContext): Promise<void> {
  const detail = eventGridEvent?.data as unknown as SceneImageRequestedEventData;
  if (!detail?.storyId || !detail?.sceneNumber) {
    context.log('Invalid SceneImageRequested payload');
    return;
  }

  await containerClient.createIfNotExists();

  try {
    const imageUrl = await generateAndUploadSceneImage(
      openai,
      containerClient,
      sharedKeyCredential,
      detail.storyId,
      detail.sceneNumber,
      detail.imagePrompt
    );
    await updateSceneStatus(storiesContainer, detail.storyId, detail.sceneNumber, { imageUrl, status: 'completed' });
  } catch (error) {
    context.error(`Failed to generate image for story ${detail.storyId} scene ${detail.sceneNumber}`, error);
    await updateSceneStatus(storiesContainer, detail.storyId, detail.sceneNumber, { status: 'failed' }).catch((updateError) => {
      context.error(`Failed to mark scene ${detail.sceneNumber} as failed`, updateError);
    });
  }
};

app.eventGrid('generateSceneImage', {
  handler: eventGridTrigger,
});
