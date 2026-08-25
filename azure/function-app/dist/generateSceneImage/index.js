"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const cosmos_1 = require("@azure/cosmos");
const openai_1 = __importDefault(require("openai"));
const storage_blob_1 = require("@azure/storage-blob");
const imageGeneration_1 = require("../shared/imageGeneration");
const cosmos = new cosmos_1.CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const sharedKeyCredential = new storage_blob_1.StorageSharedKeyCredential(accountName, accountKey);
const blobService = new storage_blob_1.BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
const containerClient = blobService.getContainerClient(process.env.STORIES_CONTAINER || 'stories');
// Phase 3: handles a single SceneImageRequested event (one per scene, published by
// generateImages). Azure Functions dispatches each event to its own independent invocation,
// so all scenes for a story generate their images in parallel instead of a sequential loop.
const eventGridTrigger = async function (eventGridEvent, context) {
    const detail = eventGridEvent?.data;
    if (!detail?.storyId || !detail?.sceneNumber) {
        context.log('Invalid SceneImageRequested payload');
        return;
    }
    await containerClient.createIfNotExists();
    try {
        const imageUrl = await (0, imageGeneration_1.generateAndUploadSceneImage)(openai, containerClient, sharedKeyCredential, detail.storyId, detail.sceneNumber, detail.imagePrompt);
        await (0, imageGeneration_1.updateSceneStatus)(storiesContainer, detail.storyId, detail.sceneNumber, { imageUrl, status: 'completed' });
    }
    catch (error) {
        context.error(`Failed to generate image for story ${detail.storyId} scene ${detail.sceneNumber}`, error);
        await (0, imageGeneration_1.updateSceneStatus)(storiesContainer, detail.storyId, detail.sceneNumber, { status: 'failed' }).catch((updateError) => {
            context.error(`Failed to mark scene ${detail.sceneNumber} as failed`, updateError);
        });
    }
};
functions_1.app.eventGrid('generateSceneImage', {
    handler: eventGridTrigger,
});
