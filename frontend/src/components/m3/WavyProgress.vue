<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    value: number;
    max?: number;
    color?: string;
    trackColor?: string;
    label?: string;
    animated?: boolean;
  }>(),
  { max: 100, color: 'primary', trackColor: 'secondary-container', label: '', animated: false }
);

const pct = computed(() => {
  if (props.max <= 0) return 0;
  return Math.max(0, Math.min(100, (props.value / props.max) * 100));
});
</script>

<template>
  <div
    class="cp-wavy"
    :class="{ 'is-full': pct >= 100, 'is-animated': animated }"
    role="progressbar"
    :aria-label="label || undefined"
    :aria-valuenow="value"
    aria-valuemin="0"
    :aria-valuemax="max"
    :style="{
      '--c': `rgb(var(--v-theme-${color}))`,
      '--t': `rgb(var(--v-theme-${trackColor}))`,
      '--p': pct,
    }"
  >
    <span v-if="pct > 0" class="cp-wavy__active" />
    <span v-if="pct < 100" class="cp-wavy__track">
      <span class="cp-wavy__stop" />
    </span>
  </div>
</template>

<style scoped>
.cp-wavy {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 12px;
}
.cp-wavy__active {
  flex: none;
  width: max(10px, calc((100% - 6px) * var(--p) / 100));
  height: 12px;
  background: var(--c);
  -webkit-mask: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 12'%3E%3Cpath d='M0 6 Q6 1.5 12 6 T24 6' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round'/%3E%3C/svg%3E")
    0 50% / 24px 12px repeat-x;
  mask: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 12'%3E%3Cpath d='M0 6 Q6 1.5 12 6 T24 6' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round'/%3E%3C/svg%3E")
    0 50% / 24px 12px repeat-x;
  transition: width var(--cp-motion-slow);
}
.cp-wavy.is-full .cp-wavy__active {
  width: 100%;
}
.cp-wavy.is-animated .cp-wavy__active {
  animation: cp-wave 1.8s linear infinite;
}
.cp-wavy__track {
  position: relative;
  flex: 1;
  min-width: 4px;
  height: 4px;
  border-radius: 999px;
  background: var(--t);
}
.cp-wavy__stop {
  position: absolute;
  right: 0;
  top: 0;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--c);
}
@keyframes cp-wave {
  to {
    -webkit-mask-position: 24px 50%;
    mask-position: 24px 50%;
  }
}
</style>
