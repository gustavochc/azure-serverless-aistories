#!/usr/bin/env node

'use strict';

const path = require('node:path');
const { CosmosClient } = require(path.resolve(__dirname, '../../function-app/node_modules/@azure/cosmos'));

const containers = [
  { name: 'characters' },
  { name: 'scenes' },
  { name: 'stories', defaultTtl: -1 },
  { name: 'childProfiles' },
];

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function migrateContainer(sourceDatabase, targetDatabase, definition) {
  const source = sourceDatabase.container(definition.name);
  const targetResponse = await targetDatabase.containers.createIfNotExists({
    id: definition.name,
    partitionKey: { paths: ['/id'] },
    ...(definition.defaultTtl === undefined ? {} : { defaultTtl: definition.defaultTtl }),
  });
  const target = targetResponse.container;
  const { resources } = await source.items.readAll().fetchAll();

  for (const item of resources) {
    await target.items.upsert(item);
  }

  console.log(`${definition.name}: copied ${resources.length} item(s)`);
}

async function main() {
  const sourceClient = new CosmosClient(required('SOURCE_COSMOS_CONNECTION_STRING'));
  const targetClient = new CosmosClient(required('TARGET_COSMOS_CONNECTION_STRING'));
  const databaseName = process.env.STORIES_DATABASE || 'aiStoriesDb';
  const sourceDatabase = sourceClient.database(databaseName);
  const targetDatabaseResponse = await targetClient.databases.createIfNotExists({ id: databaseName });
  const targetDatabase = targetDatabaseResponse.database;

  for (const definition of containers) {
    await migrateContainer(sourceDatabase, targetDatabase, definition);
  }

  console.log('Cosmos migration completed. Re-run this script before cutover if source data changes during the migration window.');
}

main().catch((error) => {
  console.error('Cosmos migration failed:', error.message);
  process.exitCode = 1;
});
