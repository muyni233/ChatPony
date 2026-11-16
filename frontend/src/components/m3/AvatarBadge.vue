<script setup lang="ts">
import { computed, ref } from 'vue';
import { initialsOf } from '../../lib/display';

const props = defineProps<{
  name: string;
  avatar?: string | null;
  color?: string | null;
  size?: number;
  rounded?: string | number;
  ring?: boolean;
}>();

const failed = ref(false);
const bg = computed(() => props.color?.trim() || '#245C50');
const px = computed(() => props.size ?? 40);

// CJK names read better as a single glyph inside a small avatar.
const label = computed(() => {
  const first = Array.from(props.name.trim())[0] ?? '';
  if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(first)) return first;
  // Multi-word Latin names keep two initials ("Twilight Sparkle" → TS); single words use one letter.
  return /\s/.test(props.name.trim()) ? initialsOf(props.name) : first.toUpperCase();
});

const fallbackStyle = computed(() => ({
  background: bg.value,
  fontSize: `${Math.max(11, Math.round(px.value * (label.value.length > 1 ? 0.36 : 0.42)))}px`,
}));
</script>

<template>
  <v-avatar
    :size="px"
:rounded="rounded"
    :style="{ '--cp-av-r': `${Math.max(8, Math.round(px * 0.28))}px` }"
    :color="avatar && !failed ? 'surface-light' : undefined"
    class="cp-avatar flex-shrink-0"
    :class="{ 'cp-avatar--ring': ring }"
  >
    <v-img v-if="avatar && !failed" :src="avatar" :alt="name" cover @error="failed = true" />
    <span v-else class="cp-avatar__fallback" :style="fallbackStyle">{{ label }}</span>
  </v-avatar>
</template>

<style scoped>
.cp-avatar {
  overflow: hidden;
}
/* Rounded-rectangle avatars keep the same corner proportion at every size */
.cp-avatar.rounded-lg {
  border-radius: var(--cp-av-r) !important;
}
/* Rounded-rectangle avatars keep the same proportion at every size */

.cp-avatar--ring {
  /* The ring matches whatever surface the avatar sits on (set --cp-ring there). */
  box-shadow: 0 0 0 2px var(--cp-ring, rgb(var(--v-theme-surface)));
}
.cp-avatar__fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: #fff;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.12);
  user-select: none;
}
</style>
