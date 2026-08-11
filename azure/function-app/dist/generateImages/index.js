"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const cosmos_1 = require("@azure/cosmos");
const openai_1 = __importDefault(require("openai"));
const storage_blob_1 = require("@azure/storage-blob");
const cosmos = new cosmos_1.CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
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
    const sasToken = (0, storage_blob_1.generateBlobSASQueryParameters)({
        containerName: containerClient.containerName,
        blobName,
        permissions: storage_blob_1.BlobSASPermissions.parse('r'),
        startsOn: new Date(),
        expiresOn: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    }, sharedKeyCredential).toString();
    const url = `${imageBlob.url}?${sasToken}`;
    const { resource: story } = await storiesContainer.item(detail.id, detail.id).read();
    await storiesContainer.item(detail.id, detail.id).replace({
        ...cleanResource(story),
        thumbnail: url,
    });
};
functions_1.app.eventGrid('generateImages', {
    handler: eventGridTrigger,
});
