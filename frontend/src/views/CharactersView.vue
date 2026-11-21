<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import M3Loader from '../components/m3/M3Loader.vue';
import { api, ApiError } from '../lib/api';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const search = ref('');
const scope = ref<'all' | 'public' | 'private'>('all');
const selectedTag = ref('all');
const groupSelection = ref<string[]>([]);
const busyId = ref<string | null>(null);

const scopedChars = computed(() =>
  store.characters.filter((ch) => {
    if (scope.value === 'public') return ch.ownerId === null;
    if (scope.value === 'private') return ch.ownerId !== null;
    return true;
  })
);

const allTags = computed(() => {
  const set = new Set<string>();
  for (const ch of scopedChars.value) {
    for (const t of ch.tags) set.add(t);
  }
  return Array.from(set);
});

watch(allTags, (tags) => {
  if (selectedTag.value !== 'all' && !tags.includes(selectedTag.value)) {
    selectedTag.value = 'all';
  }
});

const filtered = computed(() => {
  const q = (search.value ?? '').trim().toLowerCase();
  return scopedChars.value.filter((ch) => {
    if (selectedTag.value !== 'all' && !ch.tags.includes(selectedTag.value)) return false;
    if (!q) return true;
    return (
      ch.name.toLowerCase().includes(q) ||
      ch.slug.toLowerCase().includes(q) ||
      ch.description.toLowerCase().includes(q) ||
      ch.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
});

const charById = computed(() => {
  const m = new Map<string, (typeof store.characters)[number]>();
  for (const c of store.characters) m.set(c.id, c);
  return m;
});

const selectedChars = computed(() =>
  groupSelection.value
    .map((id) => charById.value.get(id))
    .filter((c): c is (typeof store.characters)[number] => Boolean(c))
);

watch(
  () => store.characters,
  (chars) => {
    const validIds = new Set(chars.map((c) => c.id));
    groupSelection.value = groupSelection.value.filter((id) => validIds.has(id));
  }
);

function toggleGroupMember(id: string) {
  if (groupSelection.value.includes(id)) {
    groupSelection.value = groupSelection.value.filter((x) => x !== id);
  } else if (groupSelection.value.length < 8) {
    groupSelection.value = [...groupSelection.value, id];
  } else {
    store.notify('群聊最多同时选择 8 位角色', 'error');
  }
}

async function startPrivate(charId: string) {
  if (!store.user) {
    store.openAuth('login');
    return;
  }
  busyId.value = charId;
  try {
    const conv = await api.createConversation({ characterIds: [charId] });
    await store.refresh();
    router.push(`/chat/${conv.id}`);
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '发起对话失败', 'error');
  } finally {
    busyId.value = null;
  }
}

async function startGroup() {
  if (!store.user) {
    store.openAuth('login');
    return;
  }
  if (groupSelection.value.length < 2) return;
  busyId.value = 'group';
  try {
    const conv = await api.createConversation({ characterIds: groupSelection.value });
    groupSelection.value = [];
    await store.refresh();
    router.push(`/chat/${conv.id}`);
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '发起群聊失败', 'error');
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="cp-page">
    <header class="cp-page-header">
      <div>
        <h1 class="cp-page-title">角色</h1>
        <p class="cp-page-subtitle">
          挑一位开始单聊，或勾选 2～8 位角色，开一场可以 @ 点名的群聊。
        </p>
      </div>
      <div class="d-flex align-center flex-wrap ga-2">
        <v-btn-toggle v-model="scope" mandatory class="cp-connected cp-seg">
          <v-btn
            v-for="opt in [
              { v: 'all', t: '全部' },
              { v: 'public', t: '官方' },
              { v: 'private', t: '自设' },
            ]"
            :key="opt.v"
            :value="opt.v"
          >
            {{ opt.t }}
          </v-btn>
        </v-btn-toggle>
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索名称、标签或简介"
          density="compact"
          clearable
          class="cp-search"
        />
      </div>
    </header>

    <div v-if="store.loading" class="cp-loading-state">
      <M3Loader :size="44" contained label="正在加载角色列表" />
    </div>

    <template v-else>
      <div v-if="allTags.length" class="cp-tagbar mb-6">
        <button
          v-ripple
          type="button"
          class="cp-filter"
          :class="{ 'is-on': selectedTag === 'all' }"
          @click="selectedTag = 'all'"
        >
          <v-icon v-if="selectedTag === 'all'" icon="mdi-check" size="16" />
          全部 <span class="cp-faint">{{ scopedChars.length }}</span>
        </button>
        <button
          v-for="tag in allTags"
          :key="tag"
          v-ripple
          type="button"
          class="cp-filter"
          :class="{ 'is-on': selectedTag === tag }"
          @click="selectedTag = tag"
        >
          <v-icon v-if="selectedTag === tag" icon="mdi-check" size="16" />
          {{ tag }}
        </button>
      </div>

      <div v-if="filtered.length" class="cp-grid">
        <div
          v-for="ch in filtered"
          :key="ch.id"
          class="cp-char-card"
          :class="{ 'is-selected': groupSelection.includes(ch.id) }"
        >
          <div class="d-flex align-start ga-3 mb-3">
            <AvatarBadge :name="ch.name" :avatar="ch.avatar" :color="ch.color" :size="56" rounded="lg" class="cp-char-card__avatar" />
            <div class="flex-grow-1 min-width-0 pt-1">
              <div class="d-flex align-center ga-2">
                <span class="text-title-medium font-weight-bold text-truncate">{{ ch.name }}</span>
                <v-chip v-if="ch.ownerId" size="x-small" color="tertiary" variant="tonal">自设</v-chip>
              </div>
              <div class="text-body-small cp-faint">@{{ ch.slug }}</div>
            </div>
            <button
              v-ripple
              type="button"
              class="cp-pick"
              :class="{ 'is-on': groupSelection.includes(ch.id) }"
              :aria-pressed="groupSelection.includes(ch.id)"
              :aria-label="groupSelection.includes(ch.id) ? `将 ${ch.name} 移出群聊` : `将 ${ch.name} 加入群聊`"
              :title="groupSelection.includes(ch.id) ? '移出群聊选择' : '加入群聊'"
              @click="toggleGroupMember(ch.id)"
            >
              <v-icon :icon="groupSelection.includes(ch.id) ? 'mdi-check' : 'mdi-account-multiple-plus-outline'" size="20" />
            </button>
          </div>

          <p class="cp-char-card__desc">
            {{ ch.description || '还没有撰写角色介绍。' }}
          </p>

          <div v-if="ch.tags.length" class="d-flex flex-wrap ga-1 mb-4">
            <span v-for="tag in ch.tags" :key="tag" class="cp-tag">{{ tag }}</span>
          </div>

          <v-btn
            color="primary"
            variant="tonal"
            block
            class="flex-grow-0"
            prepend-icon="mdi-message-outline"
            :loading="busyId === ch.id"
            @click="startPrivate(ch.id)"
          >
            开始单聊
          </v-btn>
        </div>
      </div>

      <EmptyState
        v-else
        icon="mdi-magnify"
        title="没有找到匹配的角色"
        description="换个关键词或筛选条件试试，也可以在「自设角色」创建新角色。"
      />
    </template>

    <!-- Floating group dock -->
    <transition name="cp-dock">
      <div v-if="groupSelection.length >= 1" class="cp-dock">
        <div class="cp-stack">
          <AvatarBadge
            v-for="c in selectedChars.slice(0, 4)"
            :key="c.id"
            :name="c.name"
            :avatar="c.avatar"
            :color="c.color"
            :size="30"
            ring
          />
          <span v-if="selectedChars.length > 4" class="cp-dock__more">+{{ selectedChars.length - 4 }}</span>
        </div>
        <span class="text-body-medium">
          已选 <strong>{{ groupSelection.length }}</strong> / 8
          <span v-if="groupSelection.length < 2" class="cp-faint d-none d-sm-inline">· 至少 2 位</span>
        </span>
        <v-btn size="small" variant="text" @click="groupSelection = []">清空</v-btn>
        <v-btn
          size="small"
          color="primary"
          variant="flat"
          prepend-icon="mdi-account-group-outline"
          :disabled="groupSelection.length < 2"
          :loading="busyId === 'group'"
          @click="startGroup"
        >
          发起群聊
        </v-btn>
      </div>
    </transition>
  </div>
</template>

<style scoped>
@media (max-width: 599px) {
  .cp-seg {
    flex: 1;
  }
  .cp-seg :deep(.v-btn) {
    flex: 1;
    min-width: 0;
  }
  .cp-page-header :deep(.cp-search) {
    flex: 1 1 100%;
  }
}

.cp-tagbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 599px) {
  .cp-tagbar {
    flex-wrap: nowrap;
    overflow-x: auto;
    margin-inline: -20px;
    padding-inline: 20px;
    scrollbar-width: none;
    -webkit-mask: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 28px), transparent);
    mask: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 28px), transparent);
  }
  .cp-tagbar::-webkit-scrollbar {
    display: none;
  }
}

.cp-char-card.is-selected {
  background: rgb(var(--v-theme-secondary-container));
  box-shadow: inset 0 0 0 2px rgb(var(--v-theme-primary));
}
.cp-pick {
  position: relative;
  width: 38px;
  height: 38px;
  margin: -4px -4px 0 0;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  overflow: hidden;
  transition: background-color var(--cp-fx), color var(--cp-fx);
}
.cp-pick::after {
  content: '';
  position: absolute;
  inset: 0;
  background: currentColor;
  opacity: 0;
  transition: opacity var(--cp-fx-fast);
  pointer-events: none;
}
.cp-pick:hover::after {
  opacity: 0.08;
}
.cp-pick.is-on {
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
}

.cp-dock {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 1010;
  max-width: calc(100vw - 24px);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 12px;
  border-radius: 999px;
  background: rgb(var(--v-theme-surface-container-high));
  box-shadow: var(--cp-shadow-lg);
  white-space: nowrap;
  --cp-ring: rgb(var(--v-theme-surface-container-high));
}
.cp-dock__more {
  width: 30px;
  height: 30px;
  margin-left: -8px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 600;
  color: rgb(var(--v-theme-on-secondary-container));
  background: rgb(var(--v-theme-secondary-container));
  box-shadow: 0 0 0 2px var(--cp-ring);
}
@media (min-width: 960px) {
  .cp-dock {
    left: calc(50% + 132px);
  }
}
@media (max-width: 959px) {
  .cp-dock {
    bottom: 84px;
  }
}
.cp-dock-enter-active,
.cp-dock-leave-active {
  transition: opacity var(--cp-fx), transform var(--cp-motion);
}
.cp-dock-enter-from,
.cp-dock-leave-to {
  opacity: 0;
  transform: translate(-50%, 16px) scale(0.96);
}
</style>
