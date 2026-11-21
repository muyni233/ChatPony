<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number;
    contained?: boolean;
    label?: string;
  }>(),
  { size: 44, contained: false, label: '加载中' }
);
</script>

<template>
  <span
    class="cp-loader"
    :class="{ 'cp-loader--contained': contained }"
    :style="{ '--s': `${size}px` }"
    role="progressbar"
    :aria-label="label"
  >
    <svg class="cp-loader__svg" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="cp-loader__track" cx="18" cy="18" r="14" fill="none" stroke-width="3.2" />
      <circle class="cp-loader__arc" cx="18" cy="18" r="14" fill="none" stroke-width="3.2" stroke-linecap="round" />
    </svg>
  </span>
</template>

<style scoped>
.cp-loader {
  display: inline-grid;
  place-items: center;
  width: var(--s);
  height: var(--s);
  flex-shrink: 0;
  color: rgb(var(--v-theme-primary));
}
.cp-loader--contained {
  border-radius: 50%;
  color: rgb(var(--v-theme-on-primary-container));
  background: rgb(var(--v-theme-primary-container));
}
.cp-loader__svg {
  width: 82%;
  height: 82%;
  animation: cp-loader-rotate 1.4s linear infinite;
}
.cp-loader--contained .cp-loader__svg {
  width: 62%;
  height: 62%;
}
.cp-loader__track {
  stroke: currentColor;
  opacity: 0.16;
}
.cp-loader__arc {
  stroke: currentColor;
  stroke-dasharray: 64 88;
  stroke-dashoffset: 0;
  animation: cp-loader-dash 1.4s var(--cp-ease-std) infinite;
}
@keyframes cp-loader-rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes cp-loader-dash {
  0% {
    stroke-dasharray: 8 88;
    stroke-dashoffset: 0;
  }
  50% {
    stroke-dasharray: 56 88;
    stroke-dashoffset: -18;
  }
  100% {
    stroke-dasharray: 8 88;
    stroke-dashoffset: -86;
  }
}
</style>
