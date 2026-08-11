"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStory = getStory;
const functions_1 = require("@azure/functions");
const cosmos_1 = require("@azure/cosmos");
const cosmosConnectionString = process.env.COSMOS_DB_CONNECTION_STRING || '';
const cosmos = cosmosConnectionString ? new cosmos_1.CosmosClient(cosmosConnectionString) : null;
const database = cosmos?.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const storiesContainer = database?.container(process.env.STORIES_COLLECTION || 'stories');
const mockStory = {
    id: 'demo',
    title: 'The Moonlit Garden',
    description: 'A gentle mock story served by the function app when no Cosmos DB is configured. Set COSMOS_DB_CONNECTION_STRING to read real stories.',
};
async function getStory(req, context) {
    const id = req.query.get('id');
    if (!id) {
        return { status: 400, jsonBody: { error: 'Missing story id' } };
    }
    if (!storiesContainer) {
        context.log('COSMOS_DB_CONNECTION_STRING is not set. Returning a mock story.');
        return { status: 200, jsonBody: { ...mockStory, id } };
    }
    try {
        const { resource } = await storiesContainer.item(id, id).read();
        if (!resource) {
            return { status: 404, jsonBody: { error: 'Story not found' } };
        }
        return { status: 200, jsonBody: resource };
    }
    catch (error) {
        context.error('Cosmos read failed', error);
        return { status: 500, jsonBody: { error: 'Failed to read story' } };
    }
}
functions_1.app.http('getStory', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'story',
    handler: getStory,
});
