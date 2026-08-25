"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAndUploadSceneImage = generateAndUploadSceneImage;
exports.updateSceneStatus = updateSceneStatus;
const storage_blob_1 = require("@azure/storage-blob");
async function generateAndUploadSceneImage(openai, containerClient, sharedKeyCredential, storyId, sceneNumber, prompt) {
    const response = await openai.images.generate({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
    });
    const b64Image = response.data?.[0]?.b64_json;
    if (!b64Image) {
        throw new Error('No image generated');
    }
    const blobName = `stories/${storyId}/images/scene-${sceneNumber}.png`;
    const imageBlob = containerClient.getBlockBlobClient(blobName);
    await imageBlob.uploadData(Buffer.from(b64Image, 'base64'), { blobHTTPHeaders: { blobContentType: 'image/png' } });
    const sasToken = (0, storage_blob_1.generateBlobSASQueryParameters)({
        containerName: containerClient.containerName,
        blobName,
        permissions: storage_blob_1.BlobSASPermissions.parse('r'),
        startsOn: new Date(),
        expiresOn: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    }, sharedKeyCredential).toString();
    return `${imageBlob.url}?${sasToken}`;
}
const cleanResource = (resource) => {
    const { _rid, _self, _etag, _attachments, _ts, ...rest } = resource;
    return rest;
};
// Re-reads the story doc before each write to reduce lost updates when multiple scenes
// (or generateAudio) update the same Cosmos item concurrently.
async function updateSceneStatus(storiesContainer, storyId, sceneNumber, patch) {
    const { resource: story } = await storiesContainer.item(storyId, storyId).read();
    if (!story)
        return;
    const scenes = Array.isArray(story.scenes) ? story.scenes : [];
    const index = scenes.findIndex((s) => s.sceneNumber === sceneNumber);
    if (index >= 0) {
        scenes[index] = { ...scenes[index], ...patch };
    }
    const imagesGenerated = scenes.filter((s) => s.status === 'completed').length;
    const totalImages = story.assetsStatus?.totalImages ?? scenes.length;
    const audioGenerated = story.audio?.status === 'completed';
    await storiesContainer.item(storyId, storyId).replace({
        ...cleanResource(story),
        scenes,
        thumbnail: scenes[0]?.imageUrl || story.thumbnail || '',
        assetsStatus: {
            ...story.assetsStatus,
            imagesGenerated,
            totalImages,
            completed: imagesGenerated >= totalImages && audioGenerated,
        },
    });
}
