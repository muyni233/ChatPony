import { encodeAvatarDataUrl, removeOwnedAvatar, writeAvatarImage } from './avatars';
import { getDb } from './db';
import { saveCharacter } from './repository';
import type { Row } from './mappers';
import type { Character } from './types';

/** Persist the form and its optional upload together, so a failed upload cannot create a partial role. */
export async function saveCharacterWithAvatar(
  characterId: string | null,
  input: Record<string, unknown>,
): Promise<Character> {
  const { avatarDataUrl, ...fields } = input;
  const encoded = avatarDataUrl === undefined ? null : await encodeAvatarDataUrl(avatarDataUrl);
  let previous = '';
  let uploaded = '';
  let owner = '';
  let character: Character;
  try {
    character = getDb()
      .transaction(() => {
        if (characterId) {
          const row = getDb()
            .query('SELECT avatar FROM characters WHERE id=? AND deleted_at IS NULL')
            .get(characterId) as Row | null;
          previous = String(row?.avatar || '');
        }
        // A selected upload replaces the URL field. All other character validation remains unchanged.
        const characterFields = encoded ? { ...fields, avatar: '' } : fields;
        const saved = saveCharacter(characterId, characterFields);
        owner = `character-${saved.id}`;
        if (!encoded) return saved;
        uploaded = writeAvatarImage(owner, encoded);
        getDb().query('UPDATE characters SET avatar=? WHERE id=?').run(uploaded, saved.id);
        return { ...saved, avatar: uploaded };
      })
      .immediate();
  } catch (error) {
    if (uploaded) await removeOwnedAvatar(owner, uploaded);
    throw error;
  }
  if (previous && previous !== character.avatar)
    await removeOwnedAvatar(`character-${character.id}`, previous);
  return character;
}
