// Shared prompt/title helpers for createStory and createCustomStory.
import { CharacterSheet, MemoryUpdate, SCENE_COUNT, SCENE_TEMPLATE, SceneStatus, StoryPackage, StoryScene } from './types';

const CHARACTER_CONSISTENCY_PROMPT =
  'Toddler girl with mid-long curly light brown hair, big expressive brown eyes, warm smile, soft pajamas matching the story theme, friendly child-safe appearance.';

const VISUAL_STYLE_SUFFIX =
  "Premium children's storybook illustration, soft watercolor painting, warm pastel palette, cinematic composition, magical golden lighting, cozy atmosphere, high detail, heartwarming, award-winning children's book, dreamlike quality, soft textures, beautiful depth, gentle bedtime mood, consistent character design, no text, no letters, no watermark, no logo, full scene composition.";

// Builds the prompt sent to the LLM. Keeps the original bedtime-story essence
// (Spanish, 3-year-old, gentle/calming, Disney-inspired, simple/short sentences,
// warm ending, no fear/sadness/intensity, ~200+ words) but now asks for a
// complete Story Package as strict JSON (title, scenes, image prompts, tts info).
export function buildBedtimePrompt(characterNames: string[], sceneDescription: string, memoryContext = ''): string {
  const names = characterNames.join(' and ');
  const characterWord = characterNames.length === 1 ? 'character' : 'characters';
  const memoryBlock = memoryContext ? `\n\n${memoryContext}` : '';

  return `Write as an award-winning children's storyteller, in Spanish (español), a gentle, calming bedtime story for a 3-year-old child, starring ${characterNames.length} main ${characterWord} named ${names}. Set the story in a magical, Disney-inspired scene: ${sceneDescription}. Use simple words and short, soothing sentences a toddler can easily follow, with a warm, happy ending that helps them feel safe and ready for sleep. Keep everything kind, playful, and full of gentle wonder — avoid anything scary, sad, or intense. Light, soft rhymes are welcome but not required.${memoryBlock}

The story must be narratable in approximately 90 to 120 seconds and be between 250 and 450 words long, entirely in Spanish.

Divide the story into exactly 6 narrative parts, in this order, and lower the narrative energy progressively in the last part so it helps the child fall asleep:
1. cover — a soft, inviting opening that sets the scene
2. introduction — introduces ${names} in their cozy world
3. discovery — ${names} notice or find something magical
4. adventure — a gentle, playful adventure unfolds, never scary
5. magicalMoment — the warmest, most wonder-filled moment of the story
6. sleepEnding — everything winds down softly, ${names} feel safe, and drift off to sleep

The protagonist's appearance must stay exactly the same in every scene. Character appearance: ${CHARACTER_CONSISTENCY_PROMPT}

Respond with ONLY valid JSON — no markdown, no \`\`\`json fences, no explanations, no text before or after the JSON. Match exactly this structure (fill every value, keep "status": "pending" for every scene, keep audio/assetsStatus as shown):

{
  "title": "",
  "estimatedDurationSeconds": 0,
  "characterSheet": {
    "name": "${names}",
    "appearance": "${CHARACTER_CONSISTENCY_PROMPT}",
    "visualConsistencyPrompt": "Character consistency: ${CHARACTER_CONSISTENCY_PROMPT} same appearance across all scenes."
  },
  "story": "",
  "description": "",
  "ttsInstructions": {
    "voiceStyle": "warm, gentle, bedtime",
    "speed": "slow",
    "pauses": "long",
    "emotion": "soft and comforting"
  },
  "scenes": [
    { "sceneNumber": 1, "sceneType": "cover", "sceneTitle": "", "sceneDescription": "", "storySegment": "", "startTime": "00:00", "endTime": "00:15", "startOffsetMs": 0, "endOffsetMs": 15000, "imagePrompt": "", "imageUrl": "", "status": "pending" },
    { "sceneNumber": 2, "sceneType": "introduction", "sceneTitle": "", "sceneDescription": "", "storySegment": "", "startTime": "00:15", "endTime": "00:35", "startOffsetMs": 15000, "endOffsetMs": 35000, "imagePrompt": "", "imageUrl": "", "status": "pending" },
    { "sceneNumber": 3, "sceneType": "discovery", "sceneTitle": "", "sceneDescription": "", "storySegment": "", "startTime": "00:35", "endTime": "00:55", "startOffsetMs": 35000, "endOffsetMs": 55000, "imagePrompt": "", "imageUrl": "", "status": "pending" },
    { "sceneNumber": 4, "sceneType": "adventure", "sceneTitle": "", "sceneDescription": "", "storySegment": "", "startTime": "00:55", "endTime": "01:15", "startOffsetMs": 55000, "endOffsetMs": 75000, "imagePrompt": "", "imageUrl": "", "status": "pending" },
    { "sceneNumber": 5, "sceneType": "magicalMoment", "sceneTitle": "", "sceneDescription": "", "storySegment": "", "startTime": "01:15", "endTime": "01:35", "startOffsetMs": 75000, "endOffsetMs": 95000, "imagePrompt": "", "imageUrl": "", "status": "pending" },
    { "sceneNumber": 6, "sceneType": "sleepEnding", "sceneTitle": "", "sceneDescription": "", "storySegment": "", "startTime": "01:35", "endTime": "02:00", "startOffsetMs": 95000, "endOffsetMs": 120000, "imagePrompt": "", "imageUrl": "", "status": "pending" }
  ],
  "audio": { "audioURL": "", "durationSeconds": 0, "status": "pending" },
  "assetsStatus": { "storyGenerated": true, "audioGenerated": false, "imagesGenerated": 0, "totalImages": 6, "completed": false },
  "memoryUpdate": { "newFriends": [], "newPlaces": [], "newElements": [] }
}

Rules for "story": the full story text in Spanish, warm and complete, matching the 6 parts above (this is what gets narrated as audio).
Rules for "description": a short Spanish summary of the story (used as fallback display text).
Rules for each scene:
- "sceneTitle": a short friendly Spanish title for that part.
- "sceneDescription": a short Spanish description of what happens visually.
- "storySegment": the exact excerpt of "story" that corresponds to this part.
- "imagePrompt": MUST start exactly with this line, then a blank line:
"Character consistency:
${CHARACTER_CONSISTENCY_PROMPT.replace('friendly child-safe appearance.', 'same appearance across all scenes.')}"
Then include these sections, each on its own line, filled in English, describing this specific scene:
"Scene:
Environment:
Lighting:
Composition:
Mood:
Visual style:"
The "Visual style:" line must always end with exactly this text: "${VISUAL_STYLE_SUFFIX}"

Rules for "memoryUpdate": report ONLY genuinely new recurring elements introduced in THIS story (not ones already listed in the persistent memory above, if any):
- "newFriends": short list of new named friend characters introduced (empty array if none).
- "newPlaces": short list of new named magical places introduced (empty array if none).
- "newElements": short list of new named magical objects/motifs introduced (empty array if none).

Remember: respond with ONLY the JSON object described above. No markdown, no code fences, no extra commentary.`;
}

// Strips markdown artifacts (e.g. "**Title: X**" / "**Título: X**") the LLM sometimes wraps the title in.
// Kept for backwards compatibility with any leftover plain-text parsing; the new flow reads "title" from JSON.
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^(title|t[íi]tulo)\s*[:\-]\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function parseTimeToMs(time: unknown): number | undefined {
  if (typeof time !== 'string') return undefined;
  const match = time.trim().match(/^(\d+):(\d{2})$/);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return (minutes * 60 + seconds) * 1000;
}

// Inverse of parseTimeToMs — formats milliseconds back into an "mm:ss" string.
export function msToTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeScene(raw: unknown, index: number): StoryScene {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoryScene>;
  const template = SCENE_TEMPLATE[index];
  const sceneNumber = index + 1;

  const startTime = typeof source.startTime === 'string' ? source.startTime : template.startTime;
  const endTime = typeof source.endTime === 'string' ? source.endTime : template.endTime;

  const startOffsetMs = typeof source.startOffsetMs === 'number' ? source.startOffsetMs : parseTimeToMs(startTime) ?? template.startOffsetMs;
  const endOffsetMs = typeof source.endOffsetMs === 'number' ? source.endOffsetMs : parseTimeToMs(endTime) ?? template.endOffsetMs;

  const status: SceneStatus = source.status === 'completed' || source.status === 'failed' ? source.status : 'pending';

  return {
    sceneNumber,
    sceneType: typeof source.sceneType === 'string' ? source.sceneType : template.sceneType,
    sceneTitle: typeof source.sceneTitle === 'string' ? source.sceneTitle : '',
    sceneDescription: typeof source.sceneDescription === 'string' ? source.sceneDescription : '',
    storySegment: typeof source.storySegment === 'string' ? source.storySegment : '',
    startTime,
    endTime,
    startOffsetMs,
    endOffsetMs,
    imagePrompt: typeof source.imagePrompt === 'string' ? source.imagePrompt : '',
    imageUrl: typeof source.imageUrl === 'string' ? source.imageUrl : '',
    status,
  };
}

function normalizeCharacterSheet(raw: unknown, fallbackName: string): CharacterSheet {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<CharacterSheet>;
  return {
    name: typeof source.name === 'string' && source.name ? source.name : fallbackName,
    appearance: typeof source.appearance === 'string' && source.appearance ? source.appearance : CHARACTER_CONSISTENCY_PROMPT,
    visualConsistencyPrompt:
      typeof source.visualConsistencyPrompt === 'string' && source.visualConsistencyPrompt
        ? source.visualConsistencyPrompt
        : `Character consistency: ${CHARACTER_CONSISTENCY_PROMPT}`,
  };
}

// Parses the raw LLM response into a well-formed StoryPackage, tolerating markdown fences,
// missing/partial fields, and malformed scene arrays. Always returns exactly 6 scenes.
export function safeParseStoryPackage(raw: string, fallbackName = 'la protagonista'): StoryPackage {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const title = typeof parsed.title === 'string' && parsed.title.trim() ? cleanTitle(parsed.title) : 'Cuento de buenas noches';
  const story = typeof parsed.story === 'string' && parsed.story.trim() ? parsed.story.trim() : '';
  const description = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : story;

  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes: StoryScene[] = Array.from({ length: SCENE_COUNT }, (_, i) => normalizeScene(rawScenes[i], i));

  const ttsSource = (parsed.ttsInstructions && typeof parsed.ttsInstructions === 'object' ? parsed.ttsInstructions : {}) as Record<string, unknown>;
  const ttsInstructions = {
    voiceStyle: typeof ttsSource.voiceStyle === 'string' ? ttsSource.voiceStyle : 'warm, gentle, bedtime',
    speed: typeof ttsSource.speed === 'string' ? ttsSource.speed : 'slow',
    pauses: typeof ttsSource.pauses === 'string' ? ttsSource.pauses : 'long',
    emotion: typeof ttsSource.emotion === 'string' ? ttsSource.emotion : 'soft and comforting',
  };

  const audioSource = (parsed.audio && typeof parsed.audio === 'object' ? parsed.audio : {}) as Record<string, unknown>;
  const audio = {
    audioURL: typeof audioSource.audioURL === 'string' ? audioSource.audioURL : '',
    durationSeconds: typeof audioSource.durationSeconds === 'number' ? audioSource.durationSeconds : 0,
    status: (audioSource.status === 'completed' || audioSource.status === 'failed' ? audioSource.status : 'pending') as SceneStatus,
  };

  const estimatedDurationSeconds = typeof parsed.estimatedDurationSeconds === 'number' && parsed.estimatedDurationSeconds > 0 ? parsed.estimatedDurationSeconds : 120;

  const assetsSource = (parsed.assetsStatus && typeof parsed.assetsStatus === 'object' ? parsed.assetsStatus : {}) as Record<string, unknown>;
  const assetsStatus = {
    storyGenerated: true,
    audioGenerated: typeof assetsSource.audioGenerated === 'boolean' ? assetsSource.audioGenerated : false,
    imagesGenerated: typeof assetsSource.imagesGenerated === 'number' ? assetsSource.imagesGenerated : 0,
    totalImages: typeof assetsSource.totalImages === 'number' ? assetsSource.totalImages : SCENE_COUNT,
    completed: typeof assetsSource.completed === 'boolean' ? assetsSource.completed : false,
  };

  const memoryUpdate = normalizeMemoryUpdate(parsed.memoryUpdate);

  return {
    title,
    estimatedDurationSeconds,
    characterSheet: normalizeCharacterSheet(parsed.characterSheet, fallbackName),
    story,
    description,
    ttsInstructions,
    scenes,
    audio,
    assetsStatus,
    memoryUpdate,
  };
}

function normalizeMemoryUpdate(raw: unknown): MemoryUpdate {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : [];

  return {
    newFriends: toStringArray(source.newFriends),
    newPlaces: toStringArray(source.newPlaces),
    newElements: toStringArray(source.newElements),
  };
}

// Builds an SSML document with per-scene bookmarks so a future TTS provider that supports
// SSML bookmarks (for exact audio/image sync) can report precise word-boundary offsets.
// Not wired into generateAudio yet — prepared for Phase 3.
export function buildStorySsmlFromScenes(scenes: StoryScene[]): string {
  const body = scenes
    .map((scene) => `  <bookmark mark="scene${scene.sceneNumber}"/>\n  ${escapeSsmlText(scene.storySegment)}`)
    .join('\n');
  return `<speak>\n${body}\n</speak>`;
}

function escapeSsmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
