"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugifyName = slugifyName;
exports.loadChildProfile = loadChildProfile;
exports.loadChildProfiles = loadChildProfiles;
exports.buildMemoryContext = buildMemoryContext;
exports.upsertChildProfiles = upsertChildProfiles;
const MAX_LIST_ITEMS = 12;
const MAX_STORY_HISTORY = 20;
// Turns a character name into a stable Cosmos item id, e.g. "Vega" -> "vega".
function slugifyName(name) {
    const slug = name
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-+|-+$)/g, '');
    return slug || 'character';
}
async function loadChildProfile(container, name) {
    const id = slugifyName(name);
    try {
        const { resource } = await container.item(id, id).read();
        return resource;
    }
    catch {
        return undefined;
    }
}
async function loadChildProfiles(container, names) {
    const profiles = await Promise.all(names.map((name) => loadChildProfile(container, name)));
    return profiles.filter((profile) => Boolean(profile));
}
// Builds a Spanish-language memory block to inject into the story prompt so the LLM can
// reuse recurring friends/places/elements and keep the established appearance consistent.
function buildMemoryContext(profiles) {
    if (!profiles.length)
        return '';
    const friends = dedupe(profiles.flatMap((p) => p.recurringFriends || []));
    const places = dedupe(profiles.flatMap((p) => p.recurringPlaces || []));
    const elements = dedupe(profiles.flatMap((p) => p.recurringElements || []));
    const appearance = profiles.find((p) => p.appearance)?.appearance;
    if (!friends.length && !places.length && !elements.length && !appearance)
        return '';
    const lines = ['Memoria persistente de historias anteriores (úsala para dar continuidad, sin repetir la misma trama):'];
    if (appearance)
        lines.push(`- Apariencia ya establecida del personaje (mantenla igual): ${appearance}`);
    if (friends.length)
        lines.push(`- Amigos recurrentes que puedes volver a mencionar: ${friends.join(', ')}`);
    if (places.length)
        lines.push(`- Lugares recurrentes que puedes revisitar: ${places.join(', ')}`);
    if (elements.length)
        lines.push(`- Elementos u objetos mágicos recurrentes: ${elements.join(', ')}`);
    lines.push('Puedes introducir 1 o 2 amigos, lugares o elementos nuevos si encajan bien; repórtalos en "memoryUpdate".');
    return lines.join('\n');
}
// Merges the LLM-reported new friends/places/elements into each character's persistent
// profile. Failures are the caller's responsibility to catch — this should never block
// story creation if the childProfiles container is missing (e.g. local dev without it seeded).
async function upsertChildProfiles(container, names, storyId, appearance, memoryUpdate) {
    const now = new Date().toISOString();
    await Promise.all(names.map(async (name) => {
        const id = slugifyName(name);
        const existing = await loadChildProfile(container, name);
        const profile = {
            id,
            name,
            appearance: existing?.appearance || appearance,
            recurringFriends: mergeCapped(existing?.recurringFriends, memoryUpdate?.newFriends),
            recurringPlaces: mergeCapped(existing?.recurringPlaces, memoryUpdate?.newPlaces),
            recurringElements: mergeCapped(existing?.recurringElements, memoryUpdate?.newElements),
            storyIds: [...(existing?.storyIds || []), storyId].slice(-MAX_STORY_HISTORY),
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };
        await container.items.upsert(profile);
    }));
}
function mergeCapped(existing, additions) {
    const merged = dedupe([...(existing || []), ...(additions || [])]);
    return merged.slice(-MAX_LIST_ITEMS);
}
function dedupe(items) {
    return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}
