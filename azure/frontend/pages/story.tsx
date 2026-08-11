import { GetServerSideProps } from 'next';
import { useEffect, useState } from 'react';

interface Story {
  title: string;
  description: string;
  audioURL?: string;
  thumbnail?: string;
}

interface StoryProps {
  id: string | null;
  story: Story;
}

const mockStory: Story = {
  title: 'The Moonlit Garden',
  description: 'A gentle mock story for local development and UI testing. Replace this with real data from the function app when you are ready to run the full flow.',
};

// Image generation finishes later than audio, so poll until the thumbnail shows up.
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24;

export default function StoryPage({ id, story: initialStory }: StoryProps) {
  const [story, setStory] = useState(initialStory);

  useEffect(() => {
    if (!id || story.thumbnail) {
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
          if (!cancelled && latest.thumbnail) {
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
  }, [id, story.thumbnail]);

  return (
    <main className="page">
      <div className="container">
        <div className="story-header">
          <h1 className="story-title">{story.title}</h1>
          {story.thumbnail ? <img src={story.thumbnail} alt="Story thumbnail" className="story-thumbnail" /> : null}
        </div>
        {story.audioURL ? (
          <audio controls className="story-audio">
            <source src={story.audioURL} type="audio/mpeg" />
            Your browser does not support the audio element.
          </audio>
        ) : null}
        <div className="story-text">
          {story.description.split('\n\n').map((paragraph, index) => (
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
