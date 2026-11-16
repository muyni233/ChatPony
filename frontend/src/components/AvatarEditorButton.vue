<script setup lang="ts">
import { ref } from 'vue';
import AvatarBadge from './m3/AvatarBadge.vue';

const props = defineProps<{
  name: string;
  avatar?: string | null;
  color?: string | null;
  busy?: boolean;
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
  <div class="d-flex align-center flex-wrap ga-3">
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
