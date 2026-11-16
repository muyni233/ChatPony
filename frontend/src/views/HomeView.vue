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

const charById = computed(() => {
  const m = new Map<string, (typeof store.characters)[number]>();
  for (const c of store.characters) m.set(c.id, c);
  return m;
});

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

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
  <div class="cp-page">
    <!-- Hero -->
    <header class="cp-hero cp-rise">
      <div class="cp-hero__text">
        <div class="cp-eyebrow">
          <v-icon icon="mdi-creation" size="14" />
          {{ store.user ? greeting : '欢迎来到 ChatPony' }}
        </div>
        <h1 class="cp-hero__title">
          <template v-if="store.user">{{ store.user.name }}，今天想和谁聊聊？</template>
          <template v-else>和你喜欢的角色，慢慢聊。</template>
        </h1>
        <p class="cp-page-subtitle">
          {{ store.settings.siteDescription || '多角色 AI 对话平台，支持单聊、群聊与长期记忆。' }}
        </p>
        <div class="d-flex flex-wrap ga-2 mt-5">
          <v-btn
            color="primary"
            variant="flat"
            height="42"
            prepend-icon="mdi-plus"
            @click="store.user ? store.openNewChat() : store.openAuth('login')"
          >
            {{ store.user ? '发起新对话' : '登录开始' }}
          </v-btn>
          <v-btn variant="outlined" height="42" to="/characters" class="cp-btn-ghost">浏览角色</v-btn>
        </div>
      </div>

      <div v-if="store.user" class="cp-hero__stats">
        <div class="cp-stat">
          <div class="cp-stat__num">{{ store.stats.conversations }}</div>
          <div class="cp-stat__label">段对话</div>
        </div>
        <div class="cp-stat">
          <div class="cp-stat__num">{{ store.stats.messages }}</div>
          <div class="cp-stat__label">条消息</div>
        </div>
        <div class="cp-stat">
          <div class="cp-stat__num">{{ store.stats.memories }}</div>
          <div class="cp-stat__label">条记忆</div>
        </div>
      </div>
    </header>

    <!-- Recent Conversations -->
    <section v-if="store.user && recentConversations.length" class="cp-section">
      <div class="cp-section-head">
        <h2 class="cp-section-title">继续对话</h2>
        <router-link to="/conversations" class="cp-section-link">
          全部 {{ store.conversations.length }}
          <v-icon icon="mdi-chevron-right" size="16" />
        </router-link>
      </div>
      <div class="cp-grid">
        <v-card
          v-for="conv in recentConversations"
          :key="conv.id"
          :to="`/chat/${conv.id}`"
          color="surface"
          class="cp-conv-card"
        >
          <div class="d-flex align-center ga-3 mb-3">
            <div class="cp-stack">
              <AvatarBadge
                v-for="cid in conv.characterIds.slice(0, 3)"
                :key="cid"
                :name="charById.get(cid)?.name ?? '角'"
                :avatar="charById.get(cid)?.avatar"
                :color="charById.get(cid)?.color"
                :size="32"
                ring
              />
            </div>
            <div class="flex-grow-1 min-width-0">
              <div class="text-title-small font-weight-bold text-truncate">{{ conv.title }}</div>
              <div class="text-body-small cp-faint">
                {{ conv.kind === 'group' ? `群聊 · ${conv.characterIds.length} 位角色` : '私聊' }}
              </div>
            </div>
            <span class="text-body-small cp-faint flex-shrink-0">{{ formatRelativeTime(conv.updatedAt) }}</span>
          </div>
          <div class="cp-conv-card__preview line-clamp-2">
            {{ conv.lastMessage || '点击继续对话' }}
          </div>
        </v-card>
      </div>
    </section>

    <!-- Characters -->
    <section class="cp-section">
      <div class="cp-section-head">
        <h2 class="cp-section-title">角色</h2>
        <router-link v-if="store.characters.length" to="/characters" class="cp-section-link">
          全部 {{ store.characters.length }}
          <v-icon icon="mdi-chevron-right" size="16" />
        </router-link>
      </div>

      <div v-if="featuredCharacters.length" class="cp-grid">
        <div
          v-for="ch in featuredCharacters"
          :key="ch.id"
          class="cp-char-card"
          :style="{ '--char': ch.color || '#245C50' }"
        >
          <div class="cp-char-card__wash" />
          <div class="d-flex align-start ga-3 mb-3 position-relative">
            <AvatarBadge :name="ch.name" :avatar="ch.avatar" :color="ch.color" :size="48" rounded="lg" />
            <div class="flex-grow-1 min-width-0 pt-1">
              <div class="d-flex align-center ga-2">
                <span class="text-title-medium font-weight-bold text-truncate">{{ ch.name }}</span>
                <v-chip v-if="ch.ownerId" size="x-small" color="tertiary" variant="tonal">自设</v-chip>
              </div>
              <div class="text-body-small cp-faint">@{{ ch.slug }}</div>
            </div>
          </div>

          <p class="cp-char-card__desc line-clamp-2">
            {{ ch.description || ch.greeting || '暂无角色介绍' }}
          </p>

          <div class="d-flex align-center justify-space-between ga-2 mt-auto position-relative">
            <div class="d-flex flex-wrap ga-1 min-width-0">
              <span v-for="t in ch.tags.slice(0, 3)" :key="t" class="cp-tag">{{ t }}</span>
            </div>
            <v-btn
              color="primary"
              variant="tonal"
              size="small"
              append-icon="mdi-arrow-right"
              :loading="startingId === ch.id"
              @click="quickStartChat(ch.id)"
            >
              聊天
            </v-btn>
          </div>
        </div>
      </div>

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

    <div class="cp-home-bottom">
      <!-- Announcements -->
      <section v-if="recentAnnouncements.length" class="cp-section mb-0">
        <div class="cp-section-head">
          <h2 class="cp-section-title">公告</h2>
          <router-link to="/announcements" class="cp-section-link">
            查看全部
            <v-icon icon="mdi-chevron-right" size="16" />
          </router-link>
        </div>
        <div class="cp-panel cp-ann-list">
          <div v-for="a in recentAnnouncements" :key="a.id" class="cp-ann">
            <div class="d-flex align-center ga-2 mb-1">
              <span v-if="a.pinned" class="cp-pin"><v-icon icon="mdi-pin" size="12" />置顶</span>
              <span class="text-title-small font-weight-bold text-truncate">{{ a.title }}</span>
              <span class="text-body-small cp-faint ml-auto flex-shrink-0">{{ formatRelativeTime(a.createdAt) }}</span>
            </div>
            <div class="text-body-medium cp-muted line-clamp-2">{{ a.content }}</div>
          </div>
        </div>
      </section>

      <!-- Quota -->
      <section v-if="store.quota" class="cp-section mb-0">
        <div class="cp-section-head">
          <h2 class="cp-section-title">额度</h2>
        </div>
        <QuotaCard :quota="store.quota" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.cp-hero {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  padding: 36px 32px;
  margin-bottom: 40px;
  border-radius: 24px;
  overflow: hidden;
  background:
    radial-gradient(120% 140% at 100% 0%, rgba(var(--v-theme-primary), 0.14) 0%, transparent 55%),
    radial-gradient(90% 120% at 0% 100%, rgba(var(--v-theme-tertiary), 0.1) 0%, transparent 60%),
    rgb(var(--v-theme-surface));
  border: 1px solid var(--cp-hairline);
}
.cp-hero__text {
  max-width: 560px;
}
.cp-hero__title {
  font-size: 1.625rem;
  line-height: 1.25;
  font-weight: 800;
  letter-spacing: -0.025em;
  margin: 0;
}
@media (min-width: 600px) {
  .cp-hero__title {
    font-size: 2.125rem;
  }
}
.cp-hero__stats {
  display: flex;
  gap: 8px;
}
.cp-stat {
  min-width: 92px;
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(var(--v-theme-surface), 0.7);
  border: 1px solid var(--cp-hairline);
  backdrop-filter: blur(8px);
}
.cp-stat__num {
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.cp-stat__label {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.55);
  margin-top: 2px;
}
@media (max-width: 599px) {
  .cp-hero {
    padding: 26px 20px;
  }
  .cp-hero__stats {
    width: 100%;
  }
  .cp-stat {
    flex: 1;
    min-width: 0;
  }
}

.cp-btn-ghost {
  border-color: var(--cp-hairline) !important;
  background: rgb(var(--v-theme-surface));
}

.cp-conv-card {
  padding: 16px 18px;
}
.cp-conv-card__preview {
  font-size: 0.875rem;
  line-height: 1.6;
  color: rgba(var(--v-theme-on-surface), 0.62);
  min-height: 2.8em;
}
.cp-home-bottom {
  display: grid;
  gap: 32px;
  grid-template-columns: 1fr;
}
@media (min-width: 1100px) {
  .cp-home-bottom {
    grid-template-columns: 1fr 1fr;
  }
}
.cp-ann-list {
  overflow: hidden;
}
.cp-ann {
  padding: 16px 20px;
}
.cp-ann + .cp-ann {
  border-top: 1px solid var(--cp-hairline);
}
.cp-pin {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 6px;
  color: rgb(var(--v-theme-tertiary));
  background: rgba(var(--v-theme-tertiary), 0.1);
  flex-shrink: 0;
}
</style>
