<script setup lang="ts">
import { ref } from 'vue';
import AvatarBadge from './m3/AvatarBadge.vue';

const props = defineProps<{
  name: string;
  avatar?: string | null;
  color?: string | null;
  busy?: boolean;
  /** Render as a clickable avatar with a hover overlay instead of avatar + buttons. */
  compact?: boolean;
  size?: number;
}>();

const emit = defineEmits<{
  upload: [file: File];
  clear: [];
}>();

const fileInput = ref<HTMLInputElement | null>(null);

function triggerPick() {
  if (!props.busy) fileInput.value?.click();
}

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = '';
  if (file) emit('upload', file);
}
</script>

<template>
  <div v-if="compact" class="cp-avatar-edit" :style="{ width: (size ?? 48) + 'px', height: (size ?? 48) + 'px' }">
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      style="display:none"
      @change="onFileChange"
    />
    <AvatarBadge :name="name" :avatar="avatar" :color="color" :size="size ?? 48" rounded="lg" />
    <button
      type="button"
      class="cp-avatar-edit__overlay"
      :class="{ 'is-busy': busy }"
      :aria-label="avatar ? '更换头像' : '上传头像'"
      :disabled="busy"
      @click="triggerPick"
    >
      <v-progress-circular v-if="busy" indeterminate size="18" width="2" />
      <v-icon v-else icon="mdi-camera-outline" size="18" />
    </button>
    <v-menu v-if="avatar" location="bottom start">
      <template #activator="{ props: menuProps }">
        <button type="button" class="cp-avatar-edit__more" aria-label="头像选项" v-bind="menuProps">
          <v-icon icon="mdi-dots-horizontal" size="14" />
        </button>
      </template>
      <v-list density="compact" min-width="140">
        <v-list-item prepend-icon="mdi-upload" title="更换头像" @click="triggerPick" />
        <v-list-item prepend-icon="mdi-delete-outline" title="移除头像" base-color="error" @click="emit('clear')" />
      </v-list>
    </v-menu>
  </div>
  <div v-else class="d-flex align-center flex-wrap ga-3">
    <AvatarBadge :name="name" :avatar="avatar" :color="color" :size="60" rounded="lg" />
    <div class="d-flex align-center ga-2">
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style="display:none"
        @change="onFileChange"
      />
      <v-btn
        variant="tonal"
        size="small"
        prepend-icon="mdi-upload"
        :loading="busy"
        @click="triggerPick"
      >
        {{ avatar ? '更换头像' : '上传头像' }}
      </v-btn>
      <v-btn
        v-if="avatar"
        variant="text"
        size="small"
        color="error"
        prepend-icon="mdi-delete-outline"
        :disabled="busy"
        @click="emit('clear')"
      >
        移除
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.cp-avatar-edit {
  position: relative;
  flex: none;
}
.cp-avatar-edit__overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.42);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.16s var(--cp-ease, ease);
}
.cp-avatar-edit:hover .cp-avatar-edit__overlay,
.cp-avatar-edit__overlay:focus-visible,
.cp-avatar-edit__overlay.is-busy {
  opacity: 1;
}
.cp-avatar-edit__more {
  position: absolute;
  right: -6px;
  bottom: -6px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  border: 0;
  box-shadow: var(--cp-shadow-sm);
  background: rgb(var(--v-theme-surface-container-highest));
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
}
</style>
