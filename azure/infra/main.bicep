@description('Name prefix for deployed resources')
param prefix string = 'aistories'
param location string = resourceGroup().location
param deployKeyVault bool = true
param deployEventGridSubscriptions bool = false
param enableAiGeneration bool = false
@secure()
param openAiApiKey string = ''
param websiteTimeZone string = 'Romance Standard Time'
param smtpHost string = 'smtp.gmail.com'
param smtpPort string = '587'
param smtpUser string = ''
@secure()
param smtpPass string = ''
param notifyEmailTo string = ''
param cosmosFreeTier bool = true

var storageName = toLower('${prefix}storage')
var cosmosName = toLower('${prefix}cosmos')
var functionName = '${prefix}-func'
var planName = '${prefix}-plan'
var keyVaultName = '${prefix}-kv'
var eventGridTopicName = '${prefix}-events'
var frontendPlanName = '${prefix}-frontend-plan'
var frontendName = '${prefix}-frontend'

resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: planName
  location: location
  kind: 'functionapp,linux'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-11-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'Node|22'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          name: 'WEBSITE_CONTENTSHARE'
          value: toLower(functionName)
        }
        {
          // zip-deploy on Linux auto-enables Oryx build, which conflicts with WEBSITE_RUN_FROM_PACKAGE and breaks the site
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'ENABLE_ORYX_BUILD'
          value: 'false'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
        {
          name: 'COSMOS_DB_CONNECTION_STRING'
          value: cosmosAccount.listConnectionStrings().connectionStrings[0].connectionString
        }
        {
          name: 'AZURE_STORAGE_ACCOUNT_NAME'
          value: storage.name
        }
        {
          name: 'AZURE_STORAGE_ACCOUNT_KEY'
          value: storage.listKeys().keys[0].value
        }
        {
          name: 'EVENTGRID_TOPIC_ENDPOINT'
          value: eventGridTopic.properties.endpoint
        }
        {
          name: 'EVENTGRID_KEY'
          value: eventGridTopic.listKeys().key1
        }
        {
          name: 'ENABLE_AI_GENERATION'
          value: enableAiGeneration ? 'true' : 'false'
        }
        {
          name: 'OPENAI_API_KEY'
          value: openAiApiKey
        }
        {
          name: 'WEBSITE_TIME_ZONE'
          value: websiteTimeZone
        }
        {
          name: 'SMTP_HOST'
          value: smtpHost
        }
        {
          name: 'SMTP_PORT'
          value: smtpPort
        }
        {
          name: 'SMTP_USER'
          value: smtpUser
        }
        {
          name: 'SMTP_PASS'
          value: smtpPass
        }
        {
          name: 'NOTIFY_EMAIL_TO'
          value: notifyEmailTo
        }
        {
          // string-built (not a resource reference) to avoid a circular dependency with frontendApp
          name: 'FRONTEND_BASE_URL'
          value: 'https://${frontendName}.azurewebsites.net'
        }
      ]
    }
  }
  identity: {
    type: 'SystemAssigned'
  }
}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-11-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: cosmosFreeTier
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
  }
}

resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2023-11-15' = {
  parent: cosmosAccount
  name: 'aiStoriesDb'
  properties: {
    resource: {
      id: 'aiStoriesDb'
    }
  }
}

resource charactersContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-11-15' = {
  parent: cosmosDatabase
  name: 'characters'
  properties: {
    resource: {
      id: 'characters'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
    }
  }
}

resource scenesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-11-15' = {
  parent: cosmosDatabase
  name: 'scenes'
  properties: {
    resource: {
      id: 'scenes'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
    }
  }
}

resource storiesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-11-15' = {
  parent: cosmosDatabase
  name: 'stories'
  properties: {
    resource: {
      id: 'stories'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      defaultTtl: -1
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = if (deployKeyVault) {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    accessPolicies: []
    enabledForDeployment: true
    enabledForTemplateDeployment: true
    enableSoftDelete: true
  }
}

resource eventGridTopic 'Microsoft.EventGrid/topics@2025-02-15' = {
  name: eventGridTopicName
  location: location
  properties: {
    inputSchema: 'EventGridSchema'
  }
}

resource frontendPlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: frontendPlanName
  location: location
  kind: 'linux'
  sku: {
    name: 'F1'
    tier: 'Free'
  }
  properties: {
    reserved: true
  }
}

resource frontendApp 'Microsoft.Web/sites@2024-11-01' = {
  name: frontendName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: frontendPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appSettings: [
        {
          name: 'API_BASE_URL'
          value: 'https://${functionApp.properties.defaultHostName}'
        }
        {
          name: 'USE_MOCK_DATA'
          value: 'false'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
      ]
    }
  }
}

resource generateAudioFunction 'Microsoft.Web/sites/functions@2024-11-01' existing = if (deployEventGridSubscriptions) {
  parent: functionApp
  name: 'generateAudio'
}

resource generateImagesFunction 'Microsoft.Web/sites/functions@2024-11-01' existing = if (deployEventGridSubscriptions) {
  parent: functionApp
  name: 'generateImages'
}

resource notifyStoryCreatedFunction 'Microsoft.Web/sites/functions@2024-11-01' existing = if (deployEventGridSubscriptions) {
  parent: functionApp
  name: 'notifyStoryCreated'
}

resource generateAudioSubscription 'Microsoft.EventGrid/eventSubscriptions@2025-02-15' = if (deployEventGridSubscriptions) {
  name: 'generateAudio-sub'
  scope: eventGridTopic
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: generateAudioFunction.id
        maxEventsPerBatch: 1
      }
    }
    filter: {
      includedEventTypes: [
        'StoryCreated'
      ]
    }
    eventDeliverySchema: 'EventGridSchema'
  }
}

resource notifyStoryCreatedSubscription 'Microsoft.EventGrid/eventSubscriptions@2025-02-15' = if (deployEventGridSubscriptions) {
  name: 'notifyStoryCreated-sub'
  scope: eventGridTopic
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: notifyStoryCreatedFunction.id
        maxEventsPerBatch: 1
      }
    }
    filter: {
      includedEventTypes: [
        'StoryCreated'
      ]
    }
    eventDeliverySchema: 'EventGridSchema'
  }
}

resource generateImagesSubscription 'Microsoft.EventGrid/eventSubscriptions@2025-02-15' = if (deployEventGridSubscriptions) {
  name: 'generateImages-sub'
  scope: eventGridTopic
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: generateImagesFunction.id
        maxEventsPerBatch: 1
      }
    }
    filter: {
      includedEventTypes: [
        'StoryCreated'
      ]
    }
    eventDeliverySchema: 'EventGridSchema'
  }
}

output functionAppName string = functionApp.name
output storageAccountName string = storage.name
output cosmosAccountName string = cosmosAccount.name
output keyVaultName string = deployKeyVault ? keyVault.name : ''
output eventGridTopicName string = eventGridTopic.name
output frontendAppName string = frontendApp.name
output frontendHostname string = frontendApp.properties.defaultHostName
