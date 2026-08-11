// Shared prompt/title helpers for createStory and createCustomStory.

export function buildBedtimePrompt(characterNames: string[], sceneDescription: string): string {
  const names = characterNames.join(' and ');
  const characterWord = characterNames.length === 1 ? 'character' : 'characters';
  return `Write, in Spanish (español), a gentle, calming bedtime story for a 3-year-old child, starring ${characterNames.length} main ${characterWord} named ${names}. Set the story in a magical, Disney-inspired scene: ${sceneDescription}. Use simple words and short, soothing sentences a toddler can easily follow, with a warm, happy ending that helps them feel safe and ready for sleep. Keep everything kind, playful, and full of gentle wonder — avoid anything scary, sad, or intense. Light, soft rhymes are welcome but not required. The story should be at least 200 words long. Respond entirely in Spanish, with a short, friendly title on the first line, followed by the story.`;
}

// Strips markdown artifacts (e.g. "**Title: X**" / "**Título: X**") the LLM sometimes wraps the title in.
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^(title|t[íi]tulo)\s*[:\-]\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}
