<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  icon?: string;
}>();
</script>

<template>
  <div class="cp-empty">
    <div class="d-flex flex-column align-center ga-3">
      <div v-if="icon" class="cp-empty__icon">
        <v-icon :icon="icon" size="28" />
      </div>
      <div v-else-if="$slots.icon">
        <slot name="icon" />
      </div>
      <div class="cp-empty__title">{{ title }}</div>
      <div v-if="description" class="cp-empty__desc">
        {{ description }}
      </div>
      <div v-if="$slots.action" class="mt-2 d-flex flex-wrap justify-center ga-2">
        <slot name="action" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-empty {
  padding: 52px 24px;
  text-align: center;
  border-radius: var(--cp-radius-xl);
  background: rgb(var(--v-theme-surface-container-low));
}
.cp-empty__icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: var(--cp-radius-lg-inc);
  color: rgb(var(--v-theme-on-tertiary-container));
  background: rgb(var(--v-theme-tertiary-container));
  margin-bottom: 4px;
}
.cp-empty__title {
  font-size: 1.25rem;
  line-height: 1.75rem;
  font-weight: 600;
}
.cp-empty__desc {
  max-width: 420px;
  font-size: 0.875rem;
  line-height: 1.6;
  color: rgb(var(--v-theme-on-surface-variant));
}
</style>
