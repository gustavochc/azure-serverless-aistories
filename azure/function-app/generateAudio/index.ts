import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';
import { buildStorySsmlFromScenes, msToTime } from '../shared/storyPrompt';
import { StoryCreatedEventData, StoryScene } from '../shared/types';

const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
const blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobService.getContainerClient(process.env.STORIES_CONTAINER || 'stories');

const cleanResource = (resource: any) => {
  const { _rid, _self, _etag, _attachments, _ts, ...rest } = resource;
  return rest;
};

// Phase 3: OpenAI's TTS endpoint (gpt-4o-mini-tts via /v1/audio/speech) accepts plain text
// only — it does not support SSML or return word/bookmark timestamps. As a practical
// substitute for "exact" scene offsets, we distribute the estimated narration duration
// across scenes proportionally to each scene's storySegment word count (instead of the
// fixed 15-20s buckets used as a first draft by the LLM). The SSML document with per-scene
// <bookmark> tags is still generated and stored on the story (`ssml` field) so a future
// SSML-capable TTS provider (e.g. Azure Speech) can be swapped in without further changes.
function computeExactOffsets(scenes: StoryScene[], totalDurationSeconds: number): StoryScene[] {
  if (!scenes.length) return scenes;

  const wordCounts = scenes.map((scene) => {
    const words = (scene.storySegment || '').trim().split(/\s+/).filter(Boolean).length;
    return words > 0 ? words : 1;
  });
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0) || 1;
  const totalDurationMs = Math.max(1, totalDurationSeconds) * 1000;

  let cursor = 0;
  return scenes.map((scene, index) => {
    const isLast = index === scenes.length - 1;
    const startOffsetMs = cursor;
    const endOffsetMs = isLast ? totalDurationMs : Math.round(cursor + (wordCounts[index] / totalWords) * totalDurationMs);
    cursor = endOffsetMs;

    return {
      ...scene,
      startOffsetMs,
      endOffsetMs,
      startTime: msToTime(startOffsetMs),
      endTime: msToTime(endOffsetMs),
    };
  });
}

const eventGridTrigger = async function (eventGridEvent: EventGridEvent, context: InvocationContext): Promise<void> {
  const detail = eventGridEvent?.data as unknown as StoryCreatedEventData;
  if (!detail?.id || !detail?.title) {
    context.log('Invalid event payload');
    return;
  }

  const narrationText = detail.story || detail.description;
  if (!narrationText) {
    context.log('Invalid event payload: missing story/description');
    return;
  }

  await containerClient.createIfNotExists();

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: `Este es un cuento llamado ${detail.title}. ${narrationText}`,
      format: 'mp3',
    }),
  });

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const blobName = `stories/${detail.id}/audio.mp3`;
  const audioBlob = containerClient.getBlockBlobClient(blobName);
  await audioBlob.uploadData(audioBuffer, { blobHTTPHeaders: { blobContentType: 'audio/mpeg' } });

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

  const url = `${audioBlob.url}?${sasToken}`;

  const { resource: story } = await storiesContainer.item(detail.id, detail.id).read();
  if (!story) {
    context.log(`Story ${detail.id} not found, skipping Cosmos update`);
    return;
  }

  const scenes: StoryScene[] = Array.isArray(story.scenes) ? story.scenes : [];
  const estimatedDurationSeconds = story.estimatedDurationSeconds || detail.estimatedDurationSeconds || 120;
  const updatedScenes = computeExactOffsets(scenes, estimatedDurationSeconds);
  const ssml = updatedScenes.length ? buildStorySsmlFromScenes(updatedScenes) : undefined;

  const imagesGenerated = updatedScenes.filter((s) => s.status === 'completed').length;
  const totalImages = story.assetsStatus?.totalImages ?? updatedScenes.length;

  await storiesContainer.item(detail.id, detail.id).replace({
    ...cleanResource(story),
    scenes: updatedScenes,
    ssml,
    audioURL: url,
    audio: {
      ...story.audio,
      audioURL: url,
      durationSeconds: estimatedDurationSeconds,
      status: 'completed',
    },
    assetsStatus: {
      ...story.assetsStatus,
      audioGenerated: true,
      imagesGenerated,
      totalImages,
      completed: imagesGenerated >= totalImages,
    },
  });
};

app.eventGrid('generateAudio', {
  handler: eventGridTrigger,
});

