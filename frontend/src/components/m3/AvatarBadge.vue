<script setup lang="ts">
import { computed, ref } from 'vue';
import { initialsOf } from '../../lib/display';

const props = defineProps<{
  name: string;
  avatar?: string | null;
  color?: string | null;
  size?: number;
  rounded?: string | number;
}>();

const failed = ref(false);
const bg = computed(() => props.color?.trim() || '#2B594F');
</script>

<template>
  <v-avatar
    :size="size ?? 40"
    :rounded="rounded"
    :color="avatar && !failed ? 'surface-light' : bg"
    class="font-weight-bold text-white flex-shrink-0"
  >
    <v-img
      v-if="avatar && !failed"
      :src="avatar"
      :alt="name"
      cover
      @error="failed = true"
    />
    <span v-else :style="{ fontSize: `${Math.max(11, Math.round((size ?? 40) * 0.36))}px` }">
      {{ initialsOf(name) }}
    </span>
  </v-avatar>
</template>
