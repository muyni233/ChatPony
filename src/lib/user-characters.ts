import { getDb, id } from './db';
import { AppError } from './errors';
import { toCharacter, type Row } from './mappers';
import { saveCharacterWithAvatar } from './character-avatars';
import { deleteCharacter } from './repository';
import type { Character, UserCharacters } from './types';

const editableFields = new Set([
  'name',
  'description',
  'personality',
  'greeting',
  'avatar',
  'avatarDataUrl',
  'color',
  'tags',
  'providerId',
  'active',
]);

export function getUserCharacters(userId: string): UserCharacters {
  const db = getDb();
  return db.transaction(() => {
    const user = db
      .query('SELECT character_slots FROM users WHERE id=? AND disabled=0')
      .get(userId) as Row | null;
    if (!user) throw new AppError(404, 'NOT_FOUND', '账号不可用。');
    const items = (
      db
        .query(
          'SELECT * FROM characters WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC,rowid DESC',
        )
        .all(userId) as Row[]
    ).map((row) => toCharacter(row, true));
    const limit = Number(user.character_slots);
    const models = (
      db
        .query(
          "SELECT p.id,p.name FROM providers p JOIN suppliers s ON s.id=p.supplier_id WHERE p.kind='language' AND p.active=1 AND p.deleted_at IS NULL AND s.active=1 AND s.deleted_at IS NULL ORDER BY p.created_at DESC,p.rowid DESC",
        )
        .all() as Row[]
    ).map((row) => ({ id: String(row.id), name: String(row.name) }));
    return {
      items,
      slots: { used: items.length, limit, remaining: Math.max(0, limit - items.length) },
      models,
    };
  })();
}

export async function saveUserCharacter(
  userId: string,
  characterId: string | null,
  input: Record<string, unknown>,
): Promise<Character> {
  // Do not permit owner or mention-identifier changes. Existing slugs are stable
  // across renames, and deleted roles retain their identifier for conversation history.
  const existing = characterId
    ? (getDb()
        .query('SELECT slug FROM characters WHERE id=? AND owner_id=? AND deleted_at IS NULL')
        .get(characterId, userId) as Row | null)
    : null;
  if (characterId && !existing) throw new AppError(404, 'NOT_FOUND', '角色不存在。');
  if (Object.keys(input).some((key) => !editableFields.has(key)))
    throw new AppError(400, 'VALIDATION_ERROR', '角色配置包含不可修改的字段。');
  return saveCharacterWithAvatar(
    characterId,
    {
      ...(!characterId ? { active: true } : {}),
      ...input,
      slug: existing ? String(existing.slug) : `u-${id().replaceAll('-', '')}`,
    },
    userId,
  );
}

export function deleteUserCharacter(userId: string, characterId: string): void {
  deleteCharacter(characterId, userId);
}
