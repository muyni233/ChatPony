<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import QuotaCard from '../components/QuotaCard.vue';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import { formatRelativeTime } from '../lib/display';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();
const startingId = ref<string | null>(null);

const recentConversations = computed(() => store.conversations.slice(0, 3));
const featuredCharacters = computed(() => store.characters.slice(0, 6));
const recentAnnouncements = computed(() => store.announcements.slice(0, 3));

async function quickStartChat(characterId: string) {
  if (!store.user) {
    store.openAuth('login');
    return;
  }
  startingId.value = characterId;
  try {
    const conv = await api.createConversation({ characterIds: [characterId] });
    await store.refresh();
    router.push(`/chat/${conv.id}`);
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '发起对话失败', 'error');
  } finally {
    startingId.value = null;
  }
}
</script>

<template>
  <v-container fluid class="pa-5 pa-md-8" style="max-width:1180px">
    <!-- Top Header -->
    <div class="mb-6">
      <h1 class="text-h5 text-sm-h4 font-weight-bold">
        {{ store.user ? `欢迎回来，${store.user.name}` : 'ChatPony' }}
      </h1>
      <p class="text-body-2 text-medium-emphasis mt-1 mb-0">
        {{ store.settings.siteDescription || '多角色 AI 对话平台，支持单聊、群聊与长期记忆。' }}
      </p>
    </div>

    <!-- Recent Conversations -->
    <section v-if="store.user && recentConversations.length" class="mb-7">
      <div class="d-flex align-center justify-space-between mb-3">
        <h2 class="text-subtitle-1 font-weight-bold">最近对话</h2>
        <v-btn to="/conversations" variant="text" size="small" append-icon="mdi-arrow-right">
          全部对话 ({{ store.conversations.length }})
        </v-btn>
      </div>
      <v-row>
        <v-col v-for="conv in recentConversations" :key="conv.id" cols="12" sm="6" md="4">
          <v-card :to="`/chat/${conv.id}`" color="surface" class="pa-4 fill-height d-flex flex-column justify-space-between ga-2">
            <div>
              <div class="d-flex align-center justify-space-between ga-2 mb-1">
                <div class="d-flex align-center ga-2 min-width-0">
                  <v-icon
                    size="18"
                    color="primary"
                    :icon="conv.kind === 'group' ? 'mdi-account-group-outline' : 'mdi-message-text-outline'"
                  />
                  <span class="text-subtitle-2 font-weight-bold text-truncate">{{ conv.title }}</span>
                </div>
                <span class="text-caption text-medium-emphasis flex-shrink-0">
                  {{ formatRelativeTime(conv.updatedAt) }}
                </span>
              </div>
              <div
                class="text-body-2 text-medium-emphasis"
                style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden"
              >
                {{ conv.lastMessage || '点击继续对话' }}
              </div>
            </div>
          </v-card>
        </v-col>
      </v-row>
    </section>

    <!-- Characters -->
    <section class="mb-7">
      <div class="d-flex align-center justify-space-between mb-3">
        <h2 class="text-subtitle-1 font-weight-bold">可用角色</h2>
        <v-btn v-if="store.characters.length" to="/characters" variant="text" size="small" append-icon="mdi-arrow-right">
          全部角色 ({{ store.characters.length }})
        </v-btn>
      </div>

      <v-row v-if="featuredCharacters.length">
        <v-col v-for="ch in featuredCharacters" :key="ch.id" cols="12" sm="6" md="4">
          <v-card color="surface" class="fill-height d-flex flex-column pa-4">
            <div class="d-flex align-center ga-3 mb-3">
              <AvatarBadge :name="ch.name" :avatar="ch.avatar" :color="ch.color" :size="48" rounded="lg" />
              <div class="flex-grow-1" style="min-width:0">
                <div class="d-flex align-center ga-2">
                  <span class="text-subtitle-1 font-weight-bold text-truncate">{{ ch.name }}</span>
                  <v-chip v-if="ch.ownerId" size="x-small" color="tertiary" variant="tonal">自设</v-chip>
                </div>
                <div class="text-caption text-medium-emphasis">@{{ ch.slug }}</div>
              </div>
            </div>

            <p
              class="text-body-2 text-medium-emphasis flex-grow-1 mb-3"
              style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden"
            >
              {{ ch.description || ch.greeting || '暂无角色介绍' }}
            </p>

            <div class="d-flex align-center justify-space-between ga-2 flex-wrap mt-auto">
              <div class="d-flex flex-wrap ga-1">
                <v-chip v-for="t in ch.tags.slice(0, 2)" :key="t" size="x-small" variant="tonal">
                  {{ t }}
                </v-chip>
              </div>
              <v-btn
                color="primary"
                variant="tonal"
                size="small"
                prepend-icon="mdi-chat-plus-outline"
                :loading="startingId === ch.id"
                @click="quickStartChat(ch.id)"
              >
                开始对话
              </v-btn>
            </div>
          </v-card>
        </v-col>
      </v-row>

      <EmptyState
        v-else
        icon="mdi-account-multiple-outline"
        title="暂无可用角色"
        description="管理员可在后台创建公开角色，登录后也可在「自设角色」创建你的私人角色。"
      >
        <template #action>
          <v-btn v-if="store.isAdmin" color="primary" to="/admin">前往管理后台</v-btn>
          <v-btn v-else-if="store.user" color="primary" to="/my-characters">创建自设角色</v-btn>
          <v-btn v-else color="primary" @click="store.openAuth('login')">登录账号</v-btn>
        </template>
      </EmptyState>
    </section>

    <!-- Announcements -->
    <section v-if="recentAnnouncements.length" class="mb-7">
      <div class="d-flex align-center justify-space-between mb-3">
        <h2 class="text-subtitle-1 font-weight-bold">站内公告</h2>
        <v-btn to="/announcements" variant="text" size="small" append-icon="mdi-arrow-right">查看全部</v-btn>
      </div>
      <v-row>
        <v-col v-for="a in recentAnnouncements" :key="a.id" cols="12" md="4">
          <v-card color="surface" class="pa-4 fill-height">
            <div class="d-flex align-center ga-2 mb-2">
              <v-chip v-if="a.pinned" size="x-small" color="tertiary" variant="tonal">置顶</v-chip>
              <div class="text-subtitle-2 font-weight-bold text-truncate">{{ a.title }}</div>
            </div>
            <div
              class="text-body-2 text-medium-emphasis"
              style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden"
            >
              {{ a.content }}
            </div>
          </v-card>
        </v-col>
      </v-row>
    </section>

    <!-- Quota -->
    <section v-if="store.quota">
      <QuotaCard :quota="store.quota" />
    </section>
  </v-container>
</template>
