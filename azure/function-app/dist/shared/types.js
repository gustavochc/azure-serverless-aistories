"use strict";
// Shared Story Package types used across createStory, createCustomStory, generateImages, generateAudio and getStory.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCENE_TEMPLATE = exports.SCENE_COUNT = void 0;
exports.SCENE_COUNT = 6;
exports.SCENE_TEMPLATE = [
    { sceneType: 'cover', startTime: '00:00', endTime: '00:15', startOffsetMs: 0, endOffsetMs: 15000 },
    { sceneType: 'introduction', startTime: '00:15', endTime: '00:35', startOffsetMs: 15000, endOffsetMs: 35000 },
    { sceneType: 'discovery', startTime: '00:35', endTime: '00:55', startOffsetMs: 35000, endOffsetMs: 55000 },
    { sceneType: 'adventure', startTime: '00:55', endTime: '01:15', startOffsetMs: 55000, endOffsetMs: 75000 },
    { sceneType: 'magicalMoment', startTime: '01:15', endTime: '01:35', startOffsetMs: 75000, endOffsetMs: 95000 },
    { sceneType: 'sleepEnding', startTime: '01:35', endTime: '02:00', startOffsetMs: 95000, endOffsetMs: 120000 },
];
