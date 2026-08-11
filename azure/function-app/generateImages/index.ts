import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import OpenAI from 'openai';
import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';

interface StoryCreatedEvent {
  id: string;
  title: string;
  description: string;
  scene: string;
}

const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
const blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobService.getContainerClient(process.env.STORIES_CONTAINER || 'stories');

const cleanResource = (resource: any) => {
  const { _rid, _self, _etag, _attachments, _ts, ...rest } = resource;
  return rest;
};

const eventGridTrigger = async function (eventGridEvent: EventGridEvent, context: InvocationContext): Promise<void> {
  const detail = eventGridEvent?.data as unknown as StoryCreatedEvent;
  if (!detail?.id || !detail?.scene) {
    context.log('Invalid event payload');
    return;
  }

  await containerClient.createIfNotExists();

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: detail.scene,
    n: 1,
    size: '1024x1024',
  });

  const b64Image = response.data?.[0]?.b64_json;
  if (!b64Image) {
    context.log('No image generated');
    return;
  }

  const blobName = `stories/${detail.id}/image.png`;
  const imageBlob = containerClient.getBlockBlobClient(blobName);
  await imageBlob.uploadData(Buffer.from(b64Image, 'base64'), { blobHTTPHeaders: { blobContentType: 'image/png' } });

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: containerClient.containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(),
      expiresOn: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    },
    sharedKeyCredential
  ).toString();

  const url = `${imageBlob.url}?${sasToken}`;
  const { resource: story } = await storiesContainer.item(detail.id, detail.id).read();
  await storiesContainer.item(detail.id, detail.id).replace({
    ...cleanResource(story),
    thumbnail: url,
  });
};

app.eventGrid('generateImages', {
  handler: eventGridTrigger,
});
