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
      { to: '/', label: '首页', icon: 'mdi-home-outline', iconActive: 'mdi-home' },
      { to: '/characters', label: '角色', icon: 'mdi-account-multiple-outline', iconActive: 'mdi-account-multiple' },
      { to: '/conversations', label: '对话记录', icon: 'mdi-message-text-outline', iconActive: 'mdi-message-text' },
    ],
  },
  {
    label: '创作与记忆',
    items: [
      { to: '/my-characters', label: '自设角色', icon: 'mdi-account-edit-outline', iconActive: 'mdi-account-edit' },
      { to: '/memories', label: '长期记忆', icon: 'mdi-brain', iconActive: 'mdi-brain' },
      { to: '/persona', label: '个人设定', icon: 'mdi-card-account-details-outline', iconActive: 'mdi-card-account-details' },
    ],
  },
  {
    label: '平台',
    items: [
      { to: '/announcements', label: '公告', icon: 'mdi-bullhorn-outline', iconActive: 'mdi-bullhorn' },
      { to: '/settings', label: '设置', icon: 'mdi-cog-outline', iconActive: 'mdi-cog' },
      ...(store.isAdmin ? [{ to: '/admin', label: '管理后台', icon: 'mdi-shield-crown-outline', iconActive: 'mdi-shield-crown' }] : []),
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

// M3: the selected destination shows the filled icon
function navIcon(to: string, outline: string, filled: string) {
  const active = to === '/' ? route.path === '/' : route.path.startsWith(to);
  return active ? filled : outline;
}

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
      color="surface-container-low"
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

        <div class="px-3 pt-1 pb-3">
          <button v-ripple type="button" class="cp-fab" @click="store.openNewChat(); closeIfMobile()">
            <v-icon icon="mdi-pencil-outline" size="22" />
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
                v-ripple
                :href="href"
                class="cp-nav-item"
                :class="{ 'is-active': item.to === '/' ? isExactActive : isActive }"
                @click="navigate($event); closeIfMobile()"
              >
                <v-icon :icon="(item.to === '/' ? isExactActive : isActive) ? item.iconActive : item.icon" size="22" />
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
                v-ripple
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
              <button v-ripple type="button" class="cp-account" v-bind="menuProps">
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
            <v-list density="compact" min-width="220" class="cp-menu">
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
    <v-app-bar v-if="!mdAndUp && !isChatRoute" color="background" flat density="comfortable" class="cp-appbar">
      <v-app-bar-nav-icon aria-label="打开导航菜单" @click="drawer = !drawer" />
      <v-app-bar-title>
        <span class="cp-brand__inline">
          <img src="/icon.svg" alt="" class="cp-brand__mark cp-brand__mark--sm" width="24" height="24" />
          <span class="cp-brand__name">ChatPony</span>
        </span>
      </v-app-bar-title>
      <v-btn icon variant="text" width="40" height="40" class="cp-icon-btn" aria-label="切换主题" @click="store.toggleTheme()">
        <v-icon size="22" :icon="store.theme === 'dark' ? 'mdi-white-balance-sunny' : 'mdi-weather-night'" />
      </v-btn>
      <v-btn icon variant="flat" color="primary-container" width="40" height="40" class="cp-appbar__new mr-3 ml-1" aria-label="新对话" @click="store.openNewChat()">
        <v-icon size="22">mdi-pencil-outline</v-icon>
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
      color="on-secondary-container"
      bg-color="surface-container"
      height="68"
      class="cp-bottomnav"
    >
      <v-btn to="/" exact value="home">
        <v-icon :icon="navIcon('/', 'mdi-home-variant-outline', 'mdi-home-variant')" />
        <span>首页</span>
      </v-btn>
      <v-btn to="/characters" value="characters">
        <v-icon :icon="navIcon('/characters', 'mdi-account-multiple-outline', 'mdi-account-multiple')" />
        <span>角色</span>
      </v-btn>
      <v-btn to="/conversations" value="conversations">
        <v-icon :icon="navIcon('/conversations', 'mdi-message-text-outline', 'mdi-message-text')" />
        <span>对话</span>
      </v-btn>
      <v-btn to="/memories" value="memories">
        <v-icon icon="mdi-brain" />
        <span>记忆</span>
      </v-btn>
      <v-btn value="more" @click="drawer = true">
        <v-icon icon="mdi-dots-horizontal" />
        <span>更多</span>
      </v-btn>
    </v-bottom-navigation>

    <!-- Toast -->
    <v-snackbar
      v-model="snackOpen"
      :color="latestToast?.tone === 'error' ? 'error' : 'inverse-surface'"
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
/* ---- M3 navigation drawer (standard) ---- */
.cp-sidebar {
  border: 0 !important;
}

.cp-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 12px 12px 20px;
}
.cp-brand__link {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  color: inherit;
}
.cp-brand__mark {
  width: 32px;
  height: 32px;
  flex: none;
  display: block;
  border-radius: 8px;
}
.cp-brand__mark--sm {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}
.cp-brand__inline {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
/* M3 title-large */
.cp-brand__name {
  font-weight: 500;
  font-size: 1.375rem;
  line-height: 1.75rem;
  letter-spacing: 0;
}
.cp-icon-btn {
  color: rgb(var(--v-theme-on-surface-variant));
}

/* M3 extended FAB, surface variant + lowered elevation: sits calmly in the drawer */
.cp-fab {
  position: relative;
  height: 56px;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px 0 16px;
  border: 0;
  border-radius: 16px;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: 0.00625em;
  color: rgb(var(--v-theme-primary));
  background: rgb(var(--v-theme-surface-container-highest));
  box-shadow: none;
  cursor: pointer;
  overflow: hidden;
  transition: box-shadow var(--cp-fx), border-radius var(--cp-spring-fast), transform var(--cp-spring-fast);
}
.cp-fab:active {
  border-radius: 28px;
  transform: scale(0.98);
}
.cp-fab::after {
  content: '';
  position: absolute;
  inset: 0;
  background: currentColor;
  opacity: 0;
  transition: opacity 0.15s var(--cp-ease-std);
}
.cp-fab:hover {
  box-shadow: var(--cp-shadow-sm);
}
.cp-fab:hover::after {
  opacity: 0.08;
}
.cp-fab:active::after {
  opacity: 0.12;
}

.cp-sidebar__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 20px;
  /* fade content out under the footer instead of cutting it mid-line */
  -webkit-mask: linear-gradient(180deg, #000 calc(100% - 16px), transparent);
  mask: linear-gradient(180deg, #000 calc(100% - 16px), transparent);
}
.cp-nav-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cp-nav-group + .cp-nav-group {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
}
/* M3 drawer section header: title-small, on-surface-variant */
.cp-nav-label {
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.00625em;
  line-height: 1.25rem;
  color: rgb(var(--v-theme-on-surface-variant));
  padding: 12px 16px 8px;
}
/* M3 drawer item: full-rounded active indicator, state layers */
.cp-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  height: 50px;
  padding: 0 24px 0 18px;
  border-radius: 999px;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.00625em;
  color: rgb(var(--v-theme-on-surface-variant));
  text-decoration: none;
  overflow: hidden;
  transition: background-color var(--cp-fx), color var(--cp-fx), border-radius var(--cp-spring-fast);
}
.cp-nav-item:active {
  border-radius: 16px;
}
.cp-nav-item::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(var(--v-theme-on-surface));
  opacity: 0;
  transition: opacity 0.15s var(--cp-ease-std);
  pointer-events: none;
}
.cp-nav-item:hover::after {
  opacity: 0.08;
}
.cp-nav-item:active::after {
  opacity: 0.12;
}
.cp-nav-item.is-active {
  background: rgb(var(--v-theme-secondary-container));
  color: rgb(var(--v-theme-on-secondary-container));
  font-weight: 600;
}
.cp-nav-item.is-active::after {
  background: rgb(var(--v-theme-on-secondary-container));
}
.cp-nav-item--recent {
  height: 44px;
}
.cp-recent-dots {
  display: inline-flex;
  width: 22px;
  flex-shrink: 0;
  justify-content: center;
  gap: 2px;
}
.cp-recent-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.cp-sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px 12px;
}
.cp-account {
  position: relative;
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 56px;
  padding: 0 12px 0 10px;
  border-radius: 999px;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
}
.cp-account::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(var(--v-theme-on-surface));
  opacity: 0;
  transition: opacity 0.15s var(--cp-ease-std);
}
.cp-account:hover::after {
  opacity: 0.08;
}
.cp-account__name {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
}
.cp-account__meta {
  display: block;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  line-height: 1rem;
}
/* M3 menu: surface-container, extra-small corners, elevation 2 */
.cp-menu {
  background: rgb(var(--v-theme-surface-container)) !important;
  border-radius: 4px !important;
  box-shadow: var(--cp-shadow-md) !important;
  padding: 8px 0;
}

/* ---- M3 navigation bar (mobile) ---- */
.cp-bottomnav {
  box-shadow: none !important;
}
.cp-bottomnav :deep(.v-btn) {
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-bottomnav :deep(.v-btn .v-btn__overlay),
.cp-bottomnav :deep(.v-btn .v-btn__underlay) {
  display: none;
}
.cp-bottomnav :deep(.v-btn__content) {
  position: relative;
  gap: 4px;
}
/* M3 Expressive nav bar: the active indicator springs open from the centre */
.cp-bottomnav :deep(.v-btn__content)::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 56px;
  height: 32px;
  margin-left: -28px;
  border-radius: 16px;
  background: rgb(var(--v-theme-secondary-container));
  opacity: 0;
  transform: scaleX(0.4);
  transition: transform var(--cp-spring-fast), opacity var(--cp-fx-fast);
}
.cp-bottomnav :deep(.v-btn--active .v-btn__content)::before {
  opacity: 1;
  transform: none;
}
.cp-bottomnav :deep(.v-btn__content > .v-icon) {
  position: relative;
  width: 56px;
  height: 32px;
  border-radius: 16px;
  margin: 0;
  transition: background-color var(--cp-fx);
}
.cp-bottomnav :deep(.v-btn:hover:not(.v-btn--active) .v-btn__content > .v-icon) {
  background: rgba(var(--v-theme-on-surface), 0.08);
}
.cp-bottomnav :deep(.v-btn--active) {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 700;
}
.cp-bottomnav :deep(.v-btn--active .v-btn__content > .v-icon) {
  color: rgb(var(--v-theme-on-secondary-container));
}
.cp-appbar__new {
  border-radius: 12px !important;
  color: rgb(var(--v-theme-on-primary-container)) !important;
}
</style>
