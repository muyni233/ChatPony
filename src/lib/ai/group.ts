export interface Mentionable {
  id: string;
  slug: string;
  name: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an entire handle/name, not emails or prefixes such as @luna in @lunatic. */
export function findMentions(
  content: string,
  characters: Mentionable[],
  excludeId?: string,
): string[] {
  const matches: { id: string; position: number; length: number }[] = [];
  for (const character of characters) {
    if (character.id === excludeId) continue;
    for (const alias of new Set([character.slug, character.name])) {
      if (!alias) continue;
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}\\p{M}_@./%+\\-])@${escapeRegExp(alias)}(?=$|[\\s\\p{P}\\p{S}])`,
        'giu',
      );
      for (const match of content.matchAll(pattern)) {
        const end = match.index + match[0].length;
        // Handle suffixes such as @alpha_2, @alpha-extra and email/domain-like tokens as a whole.
        if (/^[\w@/+-]/.test(content.slice(end)) || /^\.[\p{L}\p{N}]/u.test(content.slice(end)))
          continue;
        matches.push({
          id: character.id,
          position: match.index + match[1].length,
          length: alias.length,
        });
      }
    }
  }
  matches.sort((a, b) => a.position - b.position || b.length - a.length);
  const ids = new Set<string>();
  let coveredUntil = -1;
  for (const match of matches) {
    if (match.position < coveredUntil) continue;
    coveredUntil = match.position + match.length + 1;
    ids.add(match.id);
  }
  return [...ids];
}

export async function runCharacterQueue(options: {
  initialIds: string[];
  characters: Mentionable[];
  maxRounds: number;
  allowMentions: boolean;
  currentMaxRounds?: () => number;
  reply: (characterId: string, round: number) => Promise<string>;
}): Promise<{ rounds: number; limited: boolean }> {
  const valid = new Set(options.characters.map((character) => character.id));
  const queue = [...new Set(options.initialIds)].filter((characterId) => valid.has(characterId));
  const cap = Math.max(1, Math.min(12, Math.floor(options.maxRounds)));
  let rounds = 0;
  while (queue.length && rounds < Math.min(cap, options.currentMaxRounds?.() ?? cap)) {
    const characterId = queue.shift()!;
    const content = await options.reply(characterId, rounds + 1);
    rounds++;
    if (options.allowMentions) {
      for (const mentioned of findMentions(content, options.characters, characterId)) {
        if (!queue.includes(mentioned)) queue.push(mentioned);
      }
    }
  }
  return { rounds, limited: queue.length > 0 };
}
