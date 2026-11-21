<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { RouterView } from 'vue-router';
import { useTheme } from 'vuetify';
import AppShell from './components/AppShell.vue';
import AuthDialog from './components/AuthDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import NewChatModal from './components/NewChatModal.vue';
import { useAppStore } from './stores/app';

const store = useAppStore();
const vuetifyTheme = useTheme();

watch(
  () => store.theme,
  (next) => {
    vuetifyTheme.change(next);
  },
  { immediate: true }
);

onMounted(async () => {
  store.initTheme();
  await store.refresh();
});
</script>

<template>
  <AppShell>
    <RouterView v-slot="{ Component, route }">
      <Transition name="cp-view" mode="out-in">
        <component :is="Component" v-if="Component" :key="route.name ?? route.path" />
      </Transition>
    </RouterView>
  </AppShell>
  <AuthDialog />
  <NewChatModal />
  <ConfirmDialog />
</template>
