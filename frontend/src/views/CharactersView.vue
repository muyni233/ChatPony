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
  <v-container fluid class="pa-5 pa-md-8" style="max-width:1180px">
    <div class="d-flex align-end justify-space-between flex-wrap ga-4 mb-5">
      <div>
        <h1 class="text-h5 text-sm-h4 font-weight-bold">角色</h1>
        <p class="text-body-2 text-medium-emphasis mt-1 mb-0">
          点击「开始单聊」立即进入一对一对话，或勾选 2～8 位角色开启 @ 点名群聊
        </p>
      </div>
      <div class="d-flex align-center flex-wrap ga-3">
        <v-btn-toggle v-model="scope" mandatory variant="outlined" color="primary" density="compact" rounded="pill">
          <v-btn value="all">全部</v-btn>
          <v-btn value="public">官方</v-btn>
          <v-btn value="private">自设</v-btn>
        </v-btn-toggle>
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索名称、标签或简介..."
          density="compact"
          rounded="pill"
          clearable
          style="min-width:240px"
        />
      </div>
    </div>

    <v-chip-group v-if="allTags.length" v-model="selectedTag" mandatory color="primary" class="mb-5">
      <v-chip value="all" variant="tonal">全部（{{ store.characters.length }}）</v-chip>
      <v-chip v-for="tag in allTags" :key="tag" :value="tag" variant="tonal">{{ tag }}</v-chip>
    </v-chip-group>

    <v-row v-if="filtered.length">
      <v-col v-for="ch in filtered" :key="ch.id" cols="12" sm="6" lg="4">
        <v-card color="surface" class="fill-height d-flex flex-column pa-4">
          <div class="d-flex align-center ga-3 mb-3">
            <AvatarBadge :name="ch.name" :avatar="ch.avatar" :color="ch.color" :size="54" rounded="lg" />
            <div class="flex-grow-1" style="min-width:0">
              <div class="text-subtitle-1 font-weight-bold d-flex align-center ga-1">
                <span class="text-truncate">{{ ch.name }}</span>
                <v-chip v-if="ch.ownerId" size="x-small" color="tertiary" variant="tonal">自设</v-chip>
              </div>
              <div class="text-caption text-medium-emphasis">@{{ ch.slug }}</div>
            </div>
            <v-btn
              :icon="groupSelection.includes(ch.id) ? 'mdi-check-circle' : 'mdi-account-multiple-plus-outline'"
              :color="groupSelection.includes(ch.id) ? 'primary' : undefined"
              variant="text"
              size="small"
              :title="groupSelection.includes(ch.id) ? '移出群聊选择' : '选入群聊队列'"
              @click="toggleGroupMember(ch.id)"
            />
          </div>

          <p class="text-body-2 text-medium-emphasis flex-grow-1 mb-3">
            {{ ch.description || '还没有撰写角色介绍。' }}
          </p>

          <div v-if="ch.tags.length" class="d-flex flex-wrap ga-1 mb-3">
            <v-chip v-for="tag in ch.tags" :key="tag" size="x-small" variant="tonal">{{ tag }}</v-chip>
          </div>

          <v-btn
            color="primary"
            variant="tonal"
            class="w-100 flex-grow-0"
            prepend-icon="mdi-chat-plus-outline"
            :loading="busyId === ch.id"
            @click="startPrivate(ch.id)"
          >
            开始单聊
          </v-btn>
        </v-card>
      </v-col>
    </v-row>

    <EmptyState
      v-else
      icon="mdi-creation-outline"
      title="没有找到匹配的角色"
      description="试试切换筛选条件或搜索关键词，也可以在「自设角色」创建新角色。"
    />

    <!-- Floating Group Selection Dock -->
    <v-snackbar
      :model-value="groupSelection.length >= 1"
      :timeout="-1"
      location="bottom center"
      color="surface"
      elevation="6"
      rounded="pill"
    >
      <div class="d-flex align-center ga-3">
        <div class="d-flex align-center">
          <AvatarBadge
            v-for="c in selectedChars"
            :key="c.id"
            :name="c.name"
            :avatar="c.avatar"
            :color="c.color"
            :size="28"
            class="mr-1"
          />
        </div>
        <span class="text-body-2">
          已选 <strong>{{ groupSelection.length }}</strong> 位
        </span>
        <v-btn size="small" variant="text" @click="groupSelection = []">清空</v-btn>
        <v-btn
          size="small"
          color="primary"
          :disabled="groupSelection.length < 2"
          :loading="busyId === 'group'"
          @click="startGroup"
        >
          发起群聊
        </v-btn>
      </div>
    </v-snackbar>
  </v-container>
</template>
