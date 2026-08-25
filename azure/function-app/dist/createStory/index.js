"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStory = createStory;
const functions_1 = require("@azure/functions");
const cosmos_1 = require("@azure/cosmos");
const openai_1 = __importDefault(require("openai"));
const eventgrid_1 = require("@azure/eventgrid");
const storyPrompt_1 = require("../shared/storyPrompt");
const childProfile_1 = require("../shared/childProfile");
const cosmos = new cosmos_1.CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
const database = cosmos.database(process.env.STORIES_DATABASE || 'aiStoriesDb');
const charactersContainer = database.container(process.env.CHARACTERS_COLLECTION || 'characters');
const scenesContainer = database.container(process.env.SCENES_COLLECTION || 'scenes');
const storiesContainer = database.container(process.env.STORIES_COLLECTION || 'stories');
const childProfilesContainer = database.container(process.env.CHILD_PROFILES_COLLECTION || 'childProfiles');
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
const eventGridEndpoint = process.env.EVENTGRID_TOPIC_ENDPOINT || '';
const eventGridKey = process.env.EVENTGRID_KEY || '';
const eventGridClient = eventGridEndpoint && eventGridKey ? new eventgrid_1.EventGridPublisherClient(eventGridEndpoint, 'EventGrid', new eventgrid_1.AzureKeyCredential(eventGridKey)) : null;
const aiGenerationEnabled = (process.env.ENABLE_AI_GENERATION || 'false').toLowerCase() === 'true';
async function createStory(_myTimer, context) {
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
    const names = characters.map((c) => c.name);
    const memoryProfiles = await (0, childProfile_1.loadChildProfiles)(childProfilesContainer, names).catch(() => []);
    const memoryContext = (0, childProfile_1.buildMemoryContext)(memoryProfiles);
    const prompt = (0, storyPrompt_1.buildBedtimePrompt)(names, selectedScene.description, memoryContext);
    const result = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
        temperature: 0.7,
    });
    const raw = result.choices[0]?.message?.content?.trim() || '';
    const storyPackage = (0, storyPrompt_1.safeParseStoryPackage)(raw, names.join(' and '));
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
        await (0, childProfile_1.upsertChildProfiles)(childProfilesContainer, names, story.id, story.characterSheet?.appearance || '', story.memoryUpdate).catch((error) => {
            context.error('Failed to update child profiles (non-fatal)', error);
        });
    }
    if (eventGridClient && story) {
        const eventData = {
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
functions_1.app.timer('createStory', {
    schedule: '0 0 20 * * *',
    handler: createStory,
});
