<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const search = ref('');
const scope = ref<'all' | 'public' | 'private'>('all');
const selectedTag = ref('all');
const groupSelection = ref<string[]>([]);
const busyId = ref<string | null>(null);

const allTags = computed(() => {
  const set = new Set<string>();
  for (const ch of store.characters) {
    for (const t of ch.tags) set.add(t);
  }
  return Array.from(set);
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return store.characters.filter((ch) => {
    if (scope.value === 'public' && ch.ownerId !== null) return false;
    if (scope.value === 'private' && ch.ownerId === null) return false;
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

const selectedChars = computed(() =>
  store.characters.filter((c) => groupSelection.value.includes(c.id))
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
        <v-btn-toggle
          v-model="scope"
          mandatory
          density="compact"
          rounded="lg"
          class="cp-seg"
        >
          <v-btn value="all">全部</v-btn>
          <v-btn value="public">官方</v-btn>
          <v-btn value="private">自设</v-btn>
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

    <div v-if="allTags.length" class="cp-tagbar mb-6">
      <button
        type="button"
        class="cp-filter"
        :class="{ 'is-on': selectedTag === 'all' }"
        @click="selectedTag = 'all'"
      >
        全部 <span class="cp-faint">{{ store.characters.length }}</span>
      </button>
      <button
        v-for="tag in allTags"
        :key="tag"
        type="button"
        class="cp-filter"
        :class="{ 'is-on': selectedTag === tag }"
        @click="selectedTag = tag"
      >
        {{ tag }}
      </button>
    </div>

    <div v-if="filtered.length" class="cp-grid">
      <div
        v-for="ch in filtered"
        :key="ch.id"
        class="cp-char-card"
        :class="{ 'is-selected': groupSelection.includes(ch.id) }"
        :style="{ '--char': ch.color || '#245C50' }"
      >
        <div class="cp-char-card__wash" />
        <div class="d-flex align-start ga-3 mb-3 position-relative">
          <AvatarBadge :name="ch.name" :avatar="ch.avatar" :color="ch.color" :size="52" rounded="lg" />
          <div class="flex-grow-1 min-width-0 pt-1">
            <div class="d-flex align-center ga-2">
              <span class="text-title-medium font-weight-bold text-truncate">{{ ch.name }}</span>
              <v-chip v-if="ch.ownerId" size="x-small" color="tertiary" variant="tonal">自设</v-chip>
            </div>
            <div class="text-body-small cp-faint">@{{ ch.slug }}</div>
          </div>
          <button
            type="button"
            class="cp-pick"
            :class="{ 'is-on': groupSelection.includes(ch.id) }"
            :aria-pressed="groupSelection.includes(ch.id)"
            :title="groupSelection.includes(ch.id) ? '移出群聊选择' : '加入群聊'"
            @click="toggleGroupMember(ch.id)"
          >
            <v-icon :icon="groupSelection.includes(ch.id) ? 'mdi-check' : 'mdi-plus'" size="16" />
          </button>
        </div>

        <p class="cp-char-card__desc">
          {{ ch.description || '还没有撰写角色介绍。' }}
        </p>

        <div v-if="ch.tags.length" class="d-flex flex-wrap ga-1 mb-4 position-relative">
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

    <!-- Floating group dock -->
    <transition name="cp-dock">
      <div v-if="groupSelection.length >= 1" class="cp-dock">
        <div class="cp-stack">
          <AvatarBadge
            v-for="c in selectedChars"
            :key="c.id"
            :name="c.name"
            :avatar="c.avatar"
            :color="c.color"
            :size="30"
            ring
          />
        </div>
        <span class="text-body-medium">
          已选 <strong>{{ groupSelection.length }}</strong> / 8
          <span v-if="groupSelection.length < 2" class="cp-faint">· 至少 2 位</span>
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
.cp-seg {
  border: 1px solid var(--cp-hairline);
  background: rgb(var(--v-theme-surface));
  height: 40px !important;
  padding: 3px;
}
.cp-seg :deep(.v-btn) {
  height: 32px !important;
  border-radius: 8px !important;
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), 0.62);
}
.cp-seg :deep(.v-btn--active) {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.cp-seg :deep(.v-btn--active > .v-btn__overlay) {
  opacity: 0;
}

.cp-tagbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cp-filter {
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.7);
  border: 1px solid var(--cp-hairline);
  background: rgb(var(--v-theme-surface));
  cursor: pointer;
  transition: all 0.15s;
}
.cp-filter:hover {
  border-color: rgba(var(--v-theme-on-surface), 0.2);
}
.cp-filter.is-on {
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
  border-color: rgb(var(--v-theme-primary));
}
.cp-filter.is-on .cp-faint {
  color: inherit;
  opacity: 0.7;
}

.cp-char-card.is-selected {
  border-color: rgb(var(--v-theme-primary));
  box-shadow: 0 0 0 1px rgb(var(--v-theme-primary)), var(--cp-shadow-md);
}
.cp-pick {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 9px;
  border: 1px solid var(--cp-hairline);
  background: rgb(var(--v-theme-surface));
  color: rgba(var(--v-theme-on-surface), 0.6);
  cursor: pointer;
  transition: all 0.15s;
}
.cp-pick:hover {
  color: rgb(var(--v-theme-primary));
  border-color: rgba(var(--v-theme-primary), 0.4);
}
.cp-pick.is-on {
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
  border-color: rgb(var(--v-theme-primary));
}

.cp-dock {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 1010;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 8px 8px 12px;
  border-radius: 16px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--cp-hairline);
  box-shadow: var(--cp-shadow-lg);
  white-space: nowrap;
}
@media (min-width: 960px) {
  .cp-dock {
    left: calc(50% + 132px);
  }
}
@media (max-width: 959px) {
  .cp-dock {
    bottom: 76px;
  }
}
.cp-dock-enter-active,
.cp-dock-leave-active {
  transition: opacity 0.2s, transform 0.25s var(--cp-ease);
}
.cp-dock-enter-from,
.cp-dock-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>
