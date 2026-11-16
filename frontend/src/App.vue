<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { RouterView } from 'vue-router';
import { useTheme } from 'vuetify';
import AppShell from './components/AppShell.vue';
import AuthDialog from './components/AuthDialog.vue';
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
  vuetifyTheme.change(store.theme);
  await store.refresh();
});
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>
  <AuthDialog />
  <NewChatModal />
</template>
