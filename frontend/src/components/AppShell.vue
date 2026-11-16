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

function closeIfMobile() {
  if (!mdAndUp.value) drawer.value = false;
}
</script>

<template>
  <v-app>
    <!-- Desktop & Mobile Navigation Drawer -->
    <v-navigation-drawer
      v-model="drawer"
      :permanent="mdAndUp"
      :temporary="!mdAndUp"
      width="272"
      color="surface-light"
      border="0"
    >
      <div class="d-flex flex-column fill-height pa-3 ga-3">
        <!-- Brand Header -->
        <div class="d-flex align-center justify-space-between px-1 pt-1">
          <router-link to="/" class="d-flex align-center ga-3 text-decoration-none text-high-emphasis" @click="closeIfMobile">
            <v-avatar color="primary" rounded="lg" size="36">
              <v-icon icon="mdi-chat-processing-outline" color="on-primary" size="20" />
            </v-avatar>
            <div>
              <div class="text-subtitle-1 font-weight-bold" style="line-height:1.15">ChatPony</div>
              <div class="text-caption text-medium-emphasis">AI 角色对话</div>
            </div>
          </router-link>

          <v-btn
            icon
            variant="text"
            size="small"
            aria-label="切换主题"
            :title="store.theme === 'dark' ? '切换浅色模式' : '切换深色模式'"
            @click="store.toggleTheme()"
          >
            <v-icon :icon="store.theme === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'" />
          </v-btn>
        </div>

        <!-- Primary Action -->
        <v-btn
          color="primary"
          variant="flat"
          rounded="lg"
          height="46"
          class="w-100 flex-grow-0 flex-shrink-0"
          prepend-icon="mdi-chat-plus-outline"
          @click="store.openNewChat(); closeIfMobile()"
        >
          发起新对话
        </v-btn>

        <!-- Scrollable Nav + Recents -->
        <div class="flex-grow-1 overflow-y-auto d-flex flex-column ga-2 pr-1">
          <v-list nav density="compact" class="pa-0 bg-transparent">
            <template v-for="group in navGroups" :key="group.label">
              <v-list-subheader class="text-caption font-weight-bold">
                {{ group.label }}
              </v-list-subheader>
              <v-list-item
                v-for="item in group.items"
                :key="item.to"
                :to="item.to"
                :exact="item.to === '/'"
                :prepend-icon="item.icon"
                :title="item.label"
                rounded="pill"
                color="primary"
                @click="closeIfMobile"
              />
            </template>
          </v-list>

          <!-- Recent Conversations -->
          <div v-if="store.user && store.conversations.length" class="mt-1">
            <div class="text-caption font-weight-bold text-medium-emphasis px-3 mb-1">最近对话</div>
            <v-list nav density="compact" class="pa-0 bg-transparent">
              <v-list-item
                v-for="conv in store.conversations.slice(0, 6)"
                :key="conv.id"
                :to="`/chat/${conv.id}`"
                rounded="pill"
                color="secondary"
                @click="closeIfMobile"
              >
                <template #prepend>
                  <v-icon size="16" :icon="conv.kind === 'group' ? 'mdi-account-group-outline' : 'mdi-message-outline'" />
                </template>
                <v-list-item-title class="text-body-2">{{ conv.title }}</v-list-item-title>
              </v-list-item>
            </v-list>
          </div>
        </div>

        <!-- Footer Quota + Account Card -->
        <div class="mt-auto d-flex flex-column ga-2 pt-2 flex-shrink-0">
          <QuotaCard v-if="store.quota" :quota="store.quota" compact />

          <v-card v-if="store.user" color="surface" rounded="xl" class="pa-2">
            <div class="d-flex align-center ga-2">
              <AvatarBadge :name="store.user.name" :avatar="store.user.avatar" :size="36" />
              <div class="flex-grow-1" style="min-width:0">
                <div class="text-body-2 font-weight-bold text-truncate">{{ store.user.name }}</div>
                <div class="text-caption text-medium-emphasis text-truncate">
                  {{ store.user.role === 'admin' ? '管理员' : store.user.email }}
                </div>
              </div>
              <v-btn
                icon="mdi-logout"
                variant="text"
                size="small"
                aria-label="退出登录"
                title="退出登录"
                @click="store.logout()"
              />
            </div>
          </v-card>

          <v-btn
            v-else
            variant="tonal"
            color="primary"
            class="w-100"
            prepend-icon="mdi-login"
            @click="store.openAuth('login'); closeIfMobile()"
          >
            登录 / 注册
          </v-btn>
        </div>
      </div>
    </v-navigation-drawer>

    <!-- Mobile App Bar -->
    <v-app-bar v-if="!mdAndUp" color="surface-light" flat density="comfortable">
      <v-app-bar-nav-icon aria-label="打开导航菜单" @click="drawer = !drawer" />
      <v-app-bar-title class="font-weight-bold">ChatPony</v-app-bar-title>
      <v-btn icon aria-label="切换主题" @click="store.toggleTheme()">
        <v-icon :icon="store.theme === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'" />
      </v-btn>
      <v-btn
        color="primary"
        variant="tonal"
        size="small"
        prepend-icon="mdi-plus"
        class="mr-2"
        @click="store.openNewChat()"
      >
        新对话
      </v-btn>
    </v-app-bar>

    <!-- Main Workspace -->
    <v-main class="bg-background">
      <slot />
    </v-main>

    <!-- Mobile Bottom Navigation Bar (hidden on chat detail screen) -->
    <v-bottom-navigation v-if="!mdAndUp && !isChatRoute" grow color="primary" bg-color="surface-light">
      <v-btn to="/" exact value="home">
        <v-icon>mdi-home-outline</v-icon>
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
        <v-icon>mdi-menu</v-icon>
        <span>更多</span>
      </v-btn>
    </v-bottom-navigation>

    <!-- Snackbar Notification -->
    <v-snackbar
      v-model="snackOpen"
      :color="latestToast?.tone === 'error' ? 'error' : latestToast?.tone === 'success' ? 'primary' : undefined"
      rounded="pill"
      location="bottom end"
      :timeout="3200"
    >
      {{ latestToast?.text }}
    </v-snackbar>
  </v-app>
</template>
