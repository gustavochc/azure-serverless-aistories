#!/usr/bin/env node
// Seeds the characters and scenes containers with sample data.
// Usage: COSMOS_DB_CONNECTION_STRING="AccountEndpoint=...;AccountKey=...;" node seed-cosmos.js
const path = require('path');
const { CosmosClient } = require(path.join(__dirname, '../../function-app/node_modules/@azure/cosmos'));

const characters = require('../../function-app/data/characters.json');
const scenes = require('../../function-app/data/scenes.json');

const connectionString = process.env.COSMOS_DB_CONNECTION_STRING;
if (!connectionString) {
  console.error('Set COSMOS_DB_CONNECTION_STRING before running this script.');
  process.exit(1);
}

const databaseName = process.env.STORIES_DATABASE || 'aiStoriesDb';

async function seed() {
  const client = new CosmosClient(connectionString);
  const database = client.database(databaseName);

  const charactersContainer = database.container(process.env.CHARACTERS_COLLECTION || 'characters');
  for (const character of characters) {
    await charactersContainer.items.upsert(character);
  }

  const scenesContainer = database.container(process.env.SCENES_COLLECTION || 'scenes');
  for (const scene of scenes) {
    await scenesContainer.items.upsert(scene);
  }

  console.log(`Seeded ${characters.length} characters and ${scenes.length} scenes.`);
}

seed().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
