/** Mentions address exact member names, with punctuation/whitespace boundaries. */
export function mentionedCharacterIds(
  content: string,
  characters: readonly { id: string; name: string }[],
): string[] {
  const ordered = [...characters].sort((left, right) => right.name.length - left.name.length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = ordered.map((character) => escape(character.name)).join('|');
  if (!names) return [];
  const pattern = new RegExp(
    `(?:^|[\\s.,!?;:，。！？；：、()[\\]{}「」『』“”‘’])@(${names})(?=$|[\\s.,!?;:，。！？；：、()[\\]{}「」『』“”‘’])`,
    'giu',
  );
  const ids: string[] = [],
    seen = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const character = ordered.find((item) => item.name.toLowerCase() === match[1].toLowerCase());
    if (character && !seen.has(character.id)) {
      seen.add(character.id);
      ids.push(character.id);
    }
  }
  return ids;
}

export function hasAmbiguousCharacterNames(characters: readonly { name: string }[]) {
  const names = characters.map((character) => character.name.normalize('NFKC').toLowerCase());
  return new Set(names).size !== names.length;
}
