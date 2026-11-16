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
        <v-icon :icon="icon" size="26" />
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
  padding: 48px 24px;
  text-align: center;
  border: 1px dashed rgba(var(--v-border-color), 0.16);
  border-radius: var(--cp-radius-lg);
  background: rgba(var(--v-theme-surface), 0.6);
}
.cp-empty__icon {
  width: 56px;
  height: 56px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.1);
  margin-bottom: 4px;
}
.cp-empty__title {
  font-size: 1.0625rem;
  font-weight: 700;
}
.cp-empty__desc {
  max-width: 420px;
  font-size: 0.875rem;
  line-height: 1.6;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
</style>
