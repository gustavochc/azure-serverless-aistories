import { GetServerSideProps } from 'next';
import { useEffect, useState } from 'react';

interface StoryScene {
  sceneNumber: number;
  sceneType?: string;
  sceneTitle?: string;
  imageUrl?: string;
  startOffsetMs: number;
  endOffsetMs: number;
  status?: string;
}

interface StoryAudio {
  audioURL?: string;
  status?: string;
}

interface CharacterSheet {
  name?: string;
  appearance?: string;
}

interface StoryAssetsStatus {
  storyGenerated?: boolean;
  audioGenerated?: boolean;
  imagesGenerated?: number;
  totalImages?: number;
  completed?: boolean;
}

interface Story {
  title: string;
  story?: string;
  description: string;
  audioURL?: string;
  thumbnail?: string;
  scenes?: StoryScene[];
  audio?: StoryAudio;
  characterSheet?: CharacterSheet;
  assetsStatus?: StoryAssetsStatus;
}

interface StoryProps {
  id: string | null;
  story: Story;
}

const MOCK_SCENE_TEMPLATE: Array<{ sceneType: string; sceneTitle: string; startOffsetMs: number; endOffsetMs: number }> = [
  { sceneType: 'cover', sceneTitle: 'Una noche estrellada', startOffsetMs: 0, endOffsetMs: 15000 },
  { sceneType: 'introduction', sceneTitle: 'El jardín tranquilo', startOffsetMs: 15000, endOffsetMs: 35000 },
  { sceneType: 'discovery', sceneTitle: 'Una luz misteriosa', startOffsetMs: 35000, endOffsetMs: 55000 },
  { sceneType: 'adventure', sceneTitle: 'Un paseo mágico', startOffsetMs: 55000, endOffsetMs: 75000 },
  { sceneType: 'magicalMoment', sceneTitle: 'El momento mágico', startOffsetMs: 75000, endOffsetMs: 95000 },
  { sceneType: 'sleepEnding', sceneTitle: 'A dormir', startOffsetMs: 95000, endOffsetMs: 120000 },
];

const mockStory: Story = {
  title: 'The Moonlit Garden',
  description: 'A gentle mock story for local development and UI testing. Replace this with real data from the function app when you are ready to run the full flow.',
  characterSheet: {
    name: 'Vega',
    appearance: 'Toddler girl with curly light brown hair, big expressive brown eyes, warm smile, soft pajamas matching the story theme, friendly child-safe appearance.',
  },
  audio: { audioURL: '', status: 'pending' },
  scenes: MOCK_SCENE_TEMPLATE.map((scene, index) => ({
    sceneNumber: index + 1,
    sceneType: scene.sceneType,
    sceneTitle: scene.sceneTitle,
    imageUrl: `https://placehold.co/1024x1024/312e81/e0e7ff?text=Scene+${index + 1}`,
    startOffsetMs: scene.startOffsetMs,
    endOffsetMs: scene.endOffsetMs,
    status: 'completed',
  })),
  assetsStatus: {
    storyGenerated: true,
    audioGenerated: false,
    imagesGenerated: MOCK_SCENE_TEMPLATE.length,
    totalImages: MOCK_SCENE_TEMPLATE.length,
    completed: false,
  },
};

// Image generation finishes later than audio, so poll until scenes/thumbnail show up.
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24;

// Returns the scene whose [startOffsetMs, endOffsetMs) range contains currentTimeSeconds.
// Falls back to the last scene once playback runs past it, and the first scene before it starts.
export function getCurrentScene(scenes: StoryScene[] | undefined, currentTimeSeconds: number): StoryScene | undefined {
  if (!scenes || !scenes.length) {
    return undefined;
  }

  const currentTimeMs = currentTimeSeconds * 1000;
  const match = scenes.find((scene) => currentTimeMs >= scene.startOffsetMs && currentTimeMs < scene.endOffsetMs);
  if (match) {
    return match;
  }

  const lastScene = scenes[scenes.length - 1];
  if (currentTimeMs >= lastScene.endOffsetMs) {
    return lastScene;
  }

  return scenes[0];
}

function hasSceneImages(scenes: StoryScene[] | undefined): boolean {
  return Boolean(scenes?.some((scene) => scene.imageUrl));
}

export default function StoryPage({ id, story: initialStory }: StoryProps) {
  const [story, setStory] = useState(initialStory);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [audioEnded, setAudioEnded] = useState(false);

  useEffect(() => {
    const assetsReady = story.thumbnail || hasSceneImages(story.scenes);
    if (!id || assetsReady) {
      return;
    }

    let attempts = 0;
    let cancelled = false;

    const poll = async () => {
      attempts += 1;
      try {
        const res = await fetch(`/api/story?id=${encodeURIComponent(id)}`);
        if (res.ok) {
          const latest = await res.json();
          if (!cancelled && (latest.thumbnail || hasSceneImages(latest.scenes))) {
            setStory(latest);
            return;
          }
        }
      } catch {
        // ignore transient errors and keep polling
      }
      if (!cancelled && attempts < MAX_POLL_ATTEMPTS) {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    const timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, story.thumbnail, story.scenes]);

  const scenes = story.scenes;
  const currentScene = audioEnded && scenes?.length ? scenes[scenes.length - 1] : getCurrentScene(scenes, currentTimeSeconds);
  const displayImage = currentScene?.imageUrl || story.thumbnail;
  const storyText = story.story || story.description;

  return (
    <main className="page">
      <div className="container">
        <div className="story-header">
          <h1 className="story-title">{story.title}</h1>
          {displayImage ? <img src={displayImage} alt="Story scene" className="story-thumbnail" /> : null}
        </div>
        {scenes && scenes.length ? (
          <div className="story-scene-indicators">
            {scenes.map((scene) => (
              <span
                key={scene.sceneNumber}
                className={`story-scene-dot${currentScene?.sceneNumber === scene.sceneNumber ? ' story-scene-dot-active' : ''}`}
                title={scene.sceneTitle || `Scene ${scene.sceneNumber}`}
              />
            ))}
          </div>
        ) : null}
        {story.audioURL ? (
          <audio
            controls
            className="story-audio"
            onTimeUpdate={(e) => setCurrentTimeSeconds(e.currentTarget.currentTime)}
            onEnded={() => setAudioEnded(true)}
          >
            <source src={story.audioURL} type="audio/mpeg" />
            Your browser does not support the audio element.
          </audio>
        ) : null}
        <div className="story-text">
          {storyText.split('\n\n').map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>
    </main>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const id = context.query.id as string | undefined;
  const useMockData = (process.env.USE_MOCK_DATA || 'true').toLowerCase() === 'true';

  if (!id) {
    return { notFound: true };
  }

  if (useMockData) {
    return { props: { id: null, story: mockStory } };
  }

  const res = await fetch(`${process.env.API_BASE_URL || 'http://localhost:7071'}/api/story?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    return { props: { id: null, story: mockStory } };
  }

  const story = await res.json();
  return { props: { id, story } };
};

