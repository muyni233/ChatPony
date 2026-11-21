<script setup lang="ts">
import { useAppStore } from '../stores/app';

const store = useAppStore();
</script>

<template>
  <v-dialog
    :model-value="store.confirmState.open"
    max-width="420"
    @update:model-value="(v) => { if (!v) store.resolveConfirm(false); }"
  >
    <v-card class="pa-6">
      <div class="d-flex align-start ga-3 mb-3">
        <v-icon
          :icon="store.confirmState.tone === 'error' ? 'mdi-alert-circle-outline' : 'mdi-help-circle-outline'"
          :color="store.confirmState.tone === 'error' ? 'error' : 'primary'"
          size="24"
          class="mt-1 flex-shrink-0"
        />
        <div class="min-width-0">
          <h3 class="text-title-large font-weight-bold">{{ store.confirmState.title }}</h3>
          <p class="text-body-medium cp-muted mt-2 mb-0">{{ store.confirmState.message }}</p>
        </div>
      </div>

      <div class="d-flex justify-end ga-2 mt-5">
        <v-btn variant="text" @click="store.resolveConfirm(false)">
          {{ store.confirmState.cancelText || '取消' }}
        </v-btn>
        <v-btn
          :color="store.confirmState.tone === 'error' ? 'error' : 'primary'"
          variant="flat"
          @click="store.resolveConfirm(true)"
        >
          {{ store.confirmState.confirmText || '确认' }}
        </v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>
