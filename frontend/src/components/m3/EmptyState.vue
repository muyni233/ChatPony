<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  icon?: string;
}>();
</script>

<template>
  <v-card color="surface" border class="pa-8 text-center">
    <div class="d-flex flex-column align-center ga-3">
      <v-avatar v-if="icon" size="56" color="primary-container" rounded="lg">
        <v-icon :icon="icon" size="28" color="on-primary-container" />
      </v-avatar>
      <div v-else-if="$slots.icon">
        <slot name="icon" />
      </div>
      <div class="text-h6 font-weight-bold text-high-emphasis">{{ title }}</div>
      <div v-if="description" class="text-body-2 text-medium-emphasis" style="max-width:440px">
        {{ description }}
      </div>
      <div v-if="$slots.action" class="mt-2">
        <slot name="action" />
      </div>
    </div>
  </v-card>
</template>
