<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useDisplay } from 'vuetify';
import { useAppStore } from '../stores/app';
import QuotaCard from './QuotaCard.vue';
import AvatarBadge from './m3/AvatarBadge.vue';

const store = useAppStore();
const route = useRoute();
const { mdAndUp } = useDisplay();

const drawer = ref(true);
watch(mdAndUp, (wide) => {
  drawer.value = wide;
}, { immediate: true });

const isChatRoute = computed(() => route.path.startsWith('/chat/'));

const navGroups = computed(() => [
  {
    label: '对话',
    items: [
      { to: '/', label: '首页', icon: 'mdi-home-outline' },
      { to: '/characters', label: '角色', icon: 'mdi-account-multiple-outline' },
      { to: '/conversations', label: '对话记录', icon: 'mdi-message-text-outline' },
    ],
  },
  {
    label: '创作与记忆',
    items: [
      { to: '/my-characters', label: '自设角色', icon: 'mdi-account-edit-outline' },
      { to: '/memories', label: '长期记忆', icon: 'mdi-brain' },
      { to: '/persona', label: '个人设定', icon: 'mdi-card-account-details-outline' },
    ],
  },
  {
    label: '平台',
    items: [
      { to: '/announcements', label: '公告', icon: 'mdi-bullhorn-outline' },
      { to: '/settings', label: '设置', icon: 'mdi-cog-outline' },
      ...(store.isAdmin ? [{ to: '/admin', label: '管理后台', icon: 'mdi-shield-crown-outline' }] : []),
    ],
  },
]);

const latestToast = computed(() => store.toasts[store.toasts.length - 1] ?? null);
const snackOpen = computed({
  get: () => latestToast.value !== null,
  set: (v: boolean) => {
    if (!v) store.toasts = [];
  },
});

const charColor = computed(() => {
  const m = new Map<string, string>();
  for (const c of store.characters) m.set(c.id, c.color);
  return m;
});

function closeIfMobile() {
  if (!mdAndUp.value) drawer.value = false;
}
</script>

<template>
  <v-app>
    <v-navigation-drawer
      v-model="drawer"
      :permanent="mdAndUp"
      :temporary="!mdAndUp"
      width="264"
      color="surface-light"
      border="0"
      class="cp-sidebar"
    >
      <div class="d-flex flex-column fill-height">
        <!-- Brand -->
        <div class="cp-brand">
          <router-link to="/" class="cp-brand__link" @click="closeIfMobile">
            <img src="/icon.svg" alt="" class="cp-brand__mark" width="30" height="30" />
            <span class="cp-brand__name">ChatPony</span>
          </router-link>
          <v-btn
            icon
            variant="text"
            size="small"
            density="comfortable"
            class="cp-icon-btn"
            :aria-label="store.theme === 'dark' ? '切换浅色模式' : '切换深色模式'"
            @click="store.toggleTheme()"
          >
            <v-icon size="18" :icon="store.theme === 'dark' ? 'mdi-white-balance-sunny' : 'mdi-weather-night'" />
            <v-tooltip activator="parent">{{ store.theme === 'dark' ? '浅色模式' : '深色模式' }}</v-tooltip>
          </v-btn>
        </div>

        <div class="px-3 pb-2">
          <button type="button" class="cp-new-chat" @click="store.openNewChat(); closeIfMobile()">
            <v-icon icon="mdi-plus" size="18" />
            <span>发起新对话</span>
          </button>
        </div>

        <!-- Nav + Recents -->
        <div class="cp-sidebar__scroll">
          <nav v-for="group in navGroups" :key="group.label" class="cp-nav-group">
            <div class="cp-nav-label">{{ group.label }}</div>
            <router-link
              v-for="item in group.items"
              :key="item.to"
              v-slot="{ href, navigate, isActive, isExactActive }"
              :to="item.to"
              custom
            >
              <a
                :href="href"
                class="cp-nav-item"
                :class="{ 'is-active': item.to === '/' ? isExactActive : isActive }"
                @click="navigate($event); closeIfMobile()"
              >
                <v-icon :icon="item.icon" size="18" />
                <span>{{ item.label }}</span>
              </a>
            </router-link>
          </nav>

          <nav v-if="store.user && store.conversations.length" class="cp-nav-group">
            <div class="cp-nav-label">最近对话</div>
            <router-link
              v-for="conv in store.conversations.slice(0, 6)"
              :key="conv.id"
              v-slot="{ href, navigate, isActive }"
              :to="`/chat/${conv.id}`"
              custom
            >
              <a
                :href="href"
                class="cp-nav-item cp-nav-item--recent"
                :class="{ 'is-active': isActive }"
                @click="navigate($event); closeIfMobile()"
              >
                <span class="cp-recent-dots">
                  <span
                    v-for="cid in conv.characterIds.slice(0, 3)"
                    :key="cid"
                    class="cp-recent-dot"
                    :style="{ background: charColor.get(cid) || 'rgb(var(--v-theme-primary))' }"
                  />
                </span>
                <span class="text-truncate">{{ conv.title }}</span>
              </a>
            </router-link>
          </nav>
        </div>

        <!-- Footer -->
        <div class="cp-sidebar__footer">
          <QuotaCard v-if="store.quota" :quota="store.quota" compact />

          <v-menu v-if="store.user" location="top start" offset="8">
            <template #activator="{ props: menuProps }">
              <button type="button" class="cp-account" v-bind="menuProps">
                <AvatarBadge :name="store.user.name" :avatar="store.user.avatar" :size="32" />
                <span class="flex-grow-1 min-width-0 text-left">
                  <span class="cp-account__name text-truncate">{{ store.user.name }}</span>
                  <span class="cp-account__meta text-truncate">
                    {{ store.user.role === 'admin' ? '管理员' : store.user.email }}
                  </span>
                </span>
                <v-icon icon="mdi-unfold-more-horizontal" size="18" class="cp-faint" />
              </button>
            </template>
            <v-list density="compact" min-width="220" class="cp-menu" bg-color="surface">
              <v-list-item to="/settings" prepend-icon="mdi-cog-outline" title="账号设置" @click="closeIfMobile" />
              <v-list-item to="/persona" prepend-icon="mdi-card-account-details-outline" title="个人设定" @click="closeIfMobile" />
              <v-divider class="my-1" />
              <v-list-item prepend-icon="mdi-logout" title="退出登录" base-color="error" @click="store.logout()" />
            </v-list>
          </v-menu>

          <v-btn
            v-else
            variant="flat"
            color="primary"
            block
            height="40"
            prepend-icon="mdi-login"
            @click="store.openAuth('login'); closeIfMobile()"
          >
            登录 / 注册
          </v-btn>
        </div>
      </div>
    </v-navigation-drawer>

    <!-- Mobile App Bar -->
    <v-app-bar v-if="!mdAndUp && !isChatRoute" color="surface" flat density="comfortable" class="cp-appbar">
      <v-app-bar-nav-icon aria-label="打开导航菜单" @click="drawer = !drawer" />
      <v-app-bar-title>
        <span class="cp-brand__inline">
          <img src="/icon.svg" alt="" class="cp-brand__mark cp-brand__mark--sm" width="24" height="24" />
          <span class="cp-brand__name">ChatPony</span>
        </span>
      </v-app-bar-title>
      <v-btn icon size="small" aria-label="切换主题" @click="store.toggleTheme()">
        <v-icon size="20" :icon="store.theme === 'dark' ? 'mdi-white-balance-sunny' : 'mdi-weather-night'" />
      </v-btn>
      <v-btn icon size="small" color="primary" variant="tonal" class="mr-2" aria-label="新对话" @click="store.openNewChat()">
        <v-icon size="20">mdi-plus</v-icon>
      </v-btn>
    </v-app-bar>

    <!-- Main Workspace -->
    <v-main class="bg-background">
      <slot />
    </v-main>

    <!-- Mobile Bottom Navigation (hidden on chat detail screen) -->
    <v-bottom-navigation
      v-if="!mdAndUp && !isChatRoute"
      grow
      color="primary"
      bg-color="surface"
      height="62"
      class="cp-bottomnav"
    >
      <v-btn to="/" exact value="home">
        <v-icon>mdi-home-variant-outline</v-icon>
        <span>首页</span>
      </v-btn>
      <v-btn to="/characters" value="characters">
        <v-icon>mdi-account-multiple-outline</v-icon>
        <span>角色</span>
      </v-btn>
      <v-btn to="/conversations" value="conversations">
        <v-icon>mdi-message-text-outline</v-icon>
        <span>对话</span>
      </v-btn>
      <v-btn to="/memories" value="memories">
        <v-icon>mdi-brain</v-icon>
        <span>记忆</span>
      </v-btn>
      <v-btn value="more" @click="drawer = true">
        <v-icon>mdi-dots-horizontal</v-icon>
        <span>更多</span>
      </v-btn>
    </v-bottom-navigation>

    <!-- Toast -->
    <v-snackbar
      v-model="snackOpen"
      :color="latestToast?.tone === 'error' ? 'error' : undefined"
      rounded="lg"
      :location="mdAndUp ? 'bottom end' : 'top'"
      :timeout="3200"
      class="cp-toast"
    >
      <div class="d-flex align-center ga-2">
        <v-icon
          size="18"
          :icon="latestToast?.tone === 'error' ? 'mdi-alert-circle-outline' : latestToast?.tone === 'success' ? 'mdi-check-circle-outline' : 'mdi-information-outline'"
        />
        <span>{{ latestToast?.text }}</span>
      </div>
    </v-snackbar>
  </v-app>
</template>

<style scoped>
.cp-sidebar {
  border-right: 1px solid var(--cp-hairline) !important;
}

.cp-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 14px 14px 18px;
}
.cp-brand__link {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: inherit;
}
.cp-brand__mark {
  width: 30px;
  height: 30px;
  flex: none;
  display: block;
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 4px 10px -6px rgba(36, 92, 80, 0.6);
}
.cp-brand__mark--sm {
  width: 24px;
  height: 24px;
  border-radius: 6px;
}
.cp-brand__inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.cp-brand__name {
  font-weight: 800;
  font-size: 1.0625rem;
  letter-spacing: -0.02em;
}
.cp-icon-btn {
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.cp-new-chat {
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 600;
  color: rgb(var(--v-theme-on-surface));
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--cp-hairline);
  box-shadow: var(--cp-shadow-sm);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.cp-new-chat .v-icon {
  color: rgb(var(--v-theme-primary));
}
.cp-new-chat:hover {
  border-color: rgba(var(--v-theme-primary), 0.35);
  box-shadow: var(--cp-shadow-md);
}
.cp-new-chat:active {
  transform: scale(0.99);
}

.cp-sidebar__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 12px;
}
.cp-nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 14px;
}
.cp-nav-label {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: rgba(var(--v-theme-on-surface), 0.42);
  padding: 0 10px 6px;
}
.cp-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: 10px;
  font-size: 0.875rem;
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.72);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.cp-nav-item .v-icon {
  opacity: 0.75;
}
.cp-nav-item:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
  color: rgb(var(--v-theme-on-surface));
}
.cp-nav-item.is-active {
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
  box-shadow: var(--cp-shadow-sm), 0 0 0 1px var(--cp-hairline);
}
.cp-nav-item.is-active .v-icon {
  opacity: 1;
  color: rgb(var(--v-theme-primary));
}
.cp-nav-item--recent {
  font-size: 0.8125rem;
  height: 34px;
}
.cp-recent-dots {
  display: inline-flex;
  width: 18px;
  flex-shrink: 0;
  justify-content: center;
}
.cp-recent-dots {
  gap: 2px;
}
.cp-recent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.cp-sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 14px;
  border-top: 1px solid var(--cp-hairline);
}
.cp-account {
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border-radius: 12px;
  color: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.cp-account:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}
.cp-account__name {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
}
.cp-account__meta {
  display: block;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.55);
  line-height: 1.3;
}
.cp-menu {
  border: 1px solid var(--cp-hairline);
  border-radius: 12px !important;
  box-shadow: var(--cp-shadow-lg) !important;
  padding: 4px;
}

.cp-appbar {
  border-bottom: 1px solid var(--cp-hairline);
}
.cp-bottomnav {
  border-top: 1px solid var(--cp-hairline);
  box-shadow: none !important;
}
.cp-bottomnav :deep(.v-btn) {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0;
}
</style>
