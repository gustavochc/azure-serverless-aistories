"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const cosmos_1 = require("@azure/cosmos");
const storage_blob_1 = require("@azure/storage-blob");
const cosmos = new cosmos_1.CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const sharedKeyCredential = new storage_blob_1.StorageSharedKeyCredential(accountName, accountKey);
const blobService = new storage_blob_1.BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobService.getContainerClient(process.env.STORIES_CONTAINER || 'stories');
const cleanResource = (resource) => {
    const { _rid, _self, _etag, _attachments, _ts, ...rest } = resource;
    return rest;
};
const eventGridTrigger = async function (eventGridEvent, context) {
    const detail = eventGridEvent?.data;
    if (!detail?.id || !detail?.title || !detail?.description) {
        context.log('Invalid event payload');
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
            input: `Este es un cuento llamado ${detail.title}. ${detail.description}`,
            format: 'mp3',
        }),
    });
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const blobName = `stories/${detail.id}/audio.mp3`;
    const audioBlob = containerClient.getBlockBlobClient(blobName);
    await audioBlob.uploadData(audioBuffer, { blobHTTPHeaders: { blobContentType: 'audio/mpeg' } });
    const sasToken = (0, storage_blob_1.generateBlobSASQueryParameters)({
        containerName: containerClient.containerName,
        blobName,
        permissions: storage_blob_1.BlobSASPermissions.parse('r'),
        startsOn: new Date(),
        expiresOn: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    }, sharedKeyCredential).toString();
    const url = `${audioBlob.url}?${sasToken}`;
    const { resource: story } = await storiesContainer.item(detail.id, detail.id).read();
    await storiesContainer.item(detail.id, detail.id).replace({
        ...cleanResource(story),
        audioURL: url,
    });
};
functions_1.app.eventGrid('generateAudio', {
    handler: eventGridTrigger,
});
