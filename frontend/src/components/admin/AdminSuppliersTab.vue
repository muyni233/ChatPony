<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api, ApiError } from '../../lib/api';
import type { ModelCapability, ModelKind, Protocol, ProviderConfig, ReasoningEffort, SupplierConfig } from '../../lib/types';
import { useAppStore } from '../../stores/app';

const props = defineProps<{
  suppliers: SupplierConfig[];
  models: ProviderConfig[];
}>();

const emit = defineEmits<{ refresh: [] }>();
const store = useAppStore();

const protocolItems: Array<{ title: string; value: Protocol }> = [
  { title: 'OpenAI Chat Completions (兼容 / Ollama)', value: 'openai-completions' },
  { title: 'OpenAI Responses API', value: 'openai-responses' },
  { title: 'Anthropic Messages API', value: 'anthropic' },
  { title: 'Google Gemini API', value: 'gemini' },
];

const kindItems: Array<{ title: string; value: ModelKind }> = [
  { title: '语言对话模型 (Language)', value: 'language' },
  { title: '向量嵌入模型 (Embedding)', value: 'embedding' },
];

const reasoningItems: Array<{ title: string; value: ReasoningEffort }> = [
  { title: 'default (不显式覆盖)', value: 'default' },
  { title: 'none', value: 'none' },
  { title: 'minimal', value: 'minimal' },
  { title: 'low', value: 'low' },
  { title: 'medium', value: 'medium' },
  { title: 'high', value: 'high' },
  { title: 'xhigh', value: 'xhigh' },
  { title: 'max', value: 'max' },
];

const capabilityOptions: ModelCapability[] = ['text', 'image', 'audio', 'file'];
const baseUrlPlaceholder = 'https://api.openai.com/v1';

const supplierItems = computed(() =>
  props.suppliers.map((s) => ({ title: `${s.name} (${s.protocol})`, value: s.id }))
);

const supOpen = ref(false);
const editingSupId = ref<string | null>(null);
const supBusy = ref(false);
const supForm = reactive({
  name: '',
  protocol: 'openai-completions' as Protocol,
  baseUrl: '',
  apiKey: '',
  active: true,
});

const modOpen = ref(false);
const editingModId = ref<string | null>(null);
const modBusy = ref(false);
const testingId = ref<string | null>(null);
const modForm = reactive({
  name: '',
  supplierId: '',
  model: '',
  kind: 'language' as ModelKind,
  capabilities: ['text'] as ModelCapability[],
  reasoningEffort: 'default' as ReasoningEffort,
  thinkingBudget: '' as string | number,
  contextWindow: 32768,
  maxOutput: 2048,
  temperature: '' as string | number,
  active: true,
});

function parseOptionalNumber(raw: string | number | null | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function openCreateSup() {
  editingSupId.value = null;
  supForm.name = '';
  supForm.protocol = 'openai-completions';
  supForm.baseUrl = '';
  supForm.apiKey = '';
  supForm.active = true;
  supOpen.value = true;
}

function openEditSup(s: SupplierConfig) {
  editingSupId.value = s.id;
  supForm.name = s.name;
  supForm.protocol = s.protocol;
  supForm.baseUrl = s.baseUrl;
  supForm.apiKey = '';
  supForm.active = s.active;
  supOpen.value = true;
}

async function saveSup() {
  if (!supForm.name.trim() || !supForm.baseUrl.trim()) {
    store.notify('请填写供应商名称和 Base URL', 'error');
    return;
  }
  supBusy.value = true;
  try {
    if (editingSupId.value) {
      await api.adminUpdateSupplier(editingSupId.value, {
        name: supForm.name.trim(),
        protocol: supForm.protocol,
        baseUrl: supForm.baseUrl.trim(),
        apiKey: supForm.apiKey ? supForm.apiKey : undefined,
        active: supForm.active,
      });
    } else {
      await api.adminCreateSupplier({
        name: supForm.name.trim(),
        protocol: supForm.protocol,
        baseUrl: supForm.baseUrl.trim(),
        apiKey: supForm.apiKey || undefined,
        active: supForm.active,
      });
    }
    supOpen.value = false;
    emit('refresh');
    store.notify('供应商配置已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存供应商失败', 'error');
  } finally {
    supBusy.value = false;
  }
}

async function delSup(s: SupplierConfig) {
  const ok = await store.confirm({
    title: '删除供应商',
    message: `删除供应商「${s.name}」会同时下线其关联的模型配置，确认继续？`,
    confirmText: '确认删除',
    tone: 'error',
  });
  if (!ok) return;
  try {
    await api.adminDeleteSupplier(s.id);
    emit('refresh');
    store.notify('供应商已删除', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

function openCreateMod() {
  editingModId.value = null;
  modForm.name = '';
  modForm.supplierId = props.suppliers[0]?.id ?? '';
  modForm.model = '';
  modForm.kind = 'language';
  modForm.capabilities = ['text'];
  modForm.reasoningEffort = 'default';
  modForm.thinkingBudget = '';
  modForm.contextWindow = 32768;
  modForm.maxOutput = 2048;
  modForm.temperature = '';
  modForm.active = true;
  modOpen.value = true;
}

function openEditMod(m: ProviderConfig) {
  editingModId.value = m.id;
  modForm.name = m.name;
  modForm.supplierId = m.supplierId;
  modForm.model = m.model;
  modForm.kind = m.kind;
  modForm.capabilities = [...m.capabilities];
  modForm.reasoningEffort = m.reasoningEffort;
  modForm.thinkingBudget = m.thinkingBudget !== null ? String(m.thinkingBudget) : '';
  modForm.contextWindow = m.contextWindow;
  modForm.maxOutput = m.maxOutput;
  modForm.temperature = m.temperature !== null ? String(m.temperature) : '';
  modForm.active = m.active;
  modOpen.value = true;
}

async function saveMod() {
  if (!modForm.name.trim() || !modForm.supplierId || !modForm.model.trim()) {
    store.notify('请填写展示名称、所属供应商与远程模型 ID', 'error');
    return;
  }
  modBusy.value = true;
  try {
    const isLang = modForm.kind === 'language';
    const payload = {
      name: modForm.name.trim(),
      supplierId: modForm.supplierId,
      model: modForm.model.trim(),
      kind: modForm.kind,
      capabilities: isLang ? modForm.capabilities : ['text'],
      reasoningEffort: isLang ? modForm.reasoningEffort : 'default',
      thinkingBudget: isLang ? parseOptionalNumber(modForm.thinkingBudget) : null,
      contextWindow: Number(modForm.contextWindow) || 32768,
      maxOutput: isLang ? Number(modForm.maxOutput) || 2048 : 2048,
      temperature: isLang ? parseOptionalNumber(modForm.temperature) : null,
      active: modForm.active,
    };
    if (editingModId.value) {
      await api.adminUpdateModel(editingModId.value, payload);
    } else {
      await api.adminCreateModel(payload);
    }
    modOpen.value = false;
    emit('refresh');
    store.notify('模型已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存模型失败', 'error');
  } finally {
    modBusy.value = false;
  }
}

async function delMod(m: ProviderConfig) {
  const ok = await store.confirm({
    title: '删除模型配置',
    message: `确认删除模型「${m.name}」吗？`,
    confirmText: '确认删除',
    tone: 'error',
  });
  if (!ok) return;
  try {
    await api.adminDeleteModel(m.id);
    emit('refresh');
    store.notify('模型已删除', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

async function testMod(id: string) {
  testingId.value = id;
  try {
    const res = await api.adminTestModel(id);
    const info = res.dimensions
      ? `维度 ${res.dimensions} (${res.durationMs}ms)`
      : `${res.reply ?? 'OK'} (${res.durationMs}ms)`;
    store.notify(`连通性测试通过：${info}`, 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '连通性测试失败', 'error');
  } finally {
    testingId.value = null;
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-5">
    <!-- Suppliers -->
    <v-card rounded="xl" class="pa-5">
      <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
        <div>
          <h3 class="text-title-medium font-weight-bold">上游供应商（Suppliers）</h3>
          <div class="text-body-medium text-medium-emphasis">管理协议兼容网关及加密凭据</div>
        </div>
        <v-btn color="primary" prepend-icon="mdi-plus" size="small" @click="openCreateSup">
          新增供应商
        </v-btn>
      </div>

      <v-row v-if="suppliers.length" density="compact">
        <v-col v-for="s in suppliers" :key="s.id" cols="12" sm="6" lg="4">
          <v-card color="surface-container" rounded="lg" class="pa-4 h-100 d-flex flex-column justify-space-between ga-3">
            <div>
              <div class="d-flex align-center ga-2 flex-wrap mb-2">
                <span class="font-weight-bold text-body-large">{{ s.name }}</span>
                <v-chip size="x-small" color="secondary" variant="tonal">{{ s.protocol }}</v-chip>
                <v-chip size="x-small" :color="s.active ? 'success' : 'default'" variant="tonal">
                  {{ s.active ? '启用' : '停用' }}
                </v-chip>
              </div>
              <div class="text-body-small text-medium-emphasis" style="word-break:break-all">
                {{ s.baseUrl }} · {{ s.hasKey ? '已加密存储 Key' : '无 Key' }}
              </div>
            </div>
            <div class="d-flex ga-2">
              <v-btn size="small" variant="outlined" prepend-icon="mdi-pencil-outline" @click="openEditSup(s)">
                编辑
              </v-btn>
              <v-btn size="small" variant="tonal" color="error" icon="mdi-delete-outline" aria-label="删除供应商" @click="delSup(s)" />
            </div>
          </v-card>
        </v-col>
      </v-row>
      <div v-else class="text-body-medium text-medium-emphasis">暂无供应商，请先添加。</div>
    </v-card>

    <!-- Models -->
    <v-card rounded="xl" class="pa-5">
      <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
        <div>
          <h3 class="text-title-medium font-weight-bold">模型列表（Models）</h3>
          <div class="text-body-medium text-medium-emphasis">绑定语言模型或向量模型及其上下文 / 思考预算参数</div>
        </div>
        <v-btn color="primary" prepend-icon="mdi-plus" size="small" :disabled="!suppliers.length" @click="openCreateMod">
          新增模型
        </v-btn>
      </div>

      <v-row v-if="models.length" density="compact">
        <v-col v-for="m in models" :key="m.id" cols="12" sm="6" lg="4">
          <v-card color="surface-container" rounded="lg" class="pa-4 h-100 d-flex flex-column justify-space-between ga-3">
            <div>
              <div class="d-flex align-center ga-2 flex-wrap mb-2">
                <span class="font-weight-bold text-body-large">{{ m.name }}</span>
                <v-chip size="x-small" color="primary" variant="tonal">{{ m.kind === 'embedding' ? '向量' : '语言' }}</v-chip>
                <v-chip size="x-small" :color="m.active && m.supplierActive ? 'success' : 'default'" variant="tonal">
                  {{ m.active && m.supplierActive ? '可用' : '停用' }}
                </v-chip>
              </div>
              <div class="text-body-small text-medium-emphasis d-flex flex-column ga-1">
                <div>供应商：{{ m.supplierName }} ({{ m.protocol }})</div>
                <div>
                  模型 ID：<code class="font-mono">{{ m.model }}</code> · 窗口 {{ m.contextWindow }}
                  <template v-if="m.kind === 'language'"> / 输出 {{ m.maxOutput }}</template>
                </div>
                <div v-if="m.kind === 'language'">能力：{{ m.capabilities.join(', ') || 'text' }} · 思考：{{ m.reasoningEffort }}</div>
              </div>
            </div>
            <div class="d-flex ga-2 flex-wrap">
              <v-btn
                size="small"
                variant="tonal"
                color="primary"
                prepend-icon="mdi-pulse"
                :loading="testingId === m.id"
                @click="testMod(m.id)"
              >
                {{ testingId === m.id ? '测试中...' : '测试' }}
              </v-btn>
              <v-btn size="small" variant="outlined" prepend-icon="mdi-pencil-outline" @click="openEditMod(m)">
                编辑
              </v-btn>
              <v-btn size="small" variant="tonal" color="error" icon="mdi-delete-outline" aria-label="删除模型" @click="delMod(m)" />
            </div>
          </v-card>
        </v-col>
      </v-row>
      <div v-else class="text-body-medium text-medium-emphasis">暂无模型配置。</div>
    </v-card>

    <!-- Supplier Dialog -->
    <v-dialog v-model="supOpen" max-width="540" scrollable>
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <span class="font-weight-bold">{{ editingSupId ? '编辑供应商' : '新增供应商' }}</span>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="supOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-form id="cp-supplier-form" class="d-flex flex-column ga-4" @submit.prevent="saveSup">
            <v-text-field v-model="supForm.name" label="显示名称" required maxlength="80" />
            <v-select v-model="supForm.protocol" label="API 协议" :items="protocolItems" />
            <v-text-field v-model="supForm.baseUrl" label="Base URL" :placeholder="baseUrlPlaceholder" required />
            <v-text-field
              v-model="supForm.apiKey"
              :label="`API Key（${editingSupId ? '留空保持原密钥不变' : '可选'}）`"
              type="password"
              autocomplete="new-password"
            />
            <v-switch v-model="supForm.active" label="启用供应商" />
          </v-form>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="supOpen = false">取消</v-btn>
          <v-btn color="primary" type="submit" form="cp-supplier-form" :loading="supBusy">保存</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Model Dialog -->
    <v-dialog v-model="modOpen" max-width="760" scrollable>
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <span class="font-weight-bold">{{ editingModId ? '编辑模型' : '新增模型' }}</span>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="modOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-form id="cp-model-form" class="d-flex flex-column ga-4" @submit.prevent="saveMod">
            <v-row density="compact">
              <v-col cols="12" sm="6">
                <v-text-field v-model="modForm.name" label="展示名称" required />
              </v-col>
              <v-col cols="12" sm="6">
                <v-select v-model="modForm.supplierId" label="所属供应商" :items="supplierItems" required />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model="modForm.model" label="远程模型 ID" placeholder="例如：claude-sonnet-4-5" required />
              </v-col>
              <v-col cols="12" sm="6">
                <v-select v-model="modForm.kind" label="模型类型" :items="kindItems" />
              </v-col>
            </v-row>

            <div v-if="modForm.kind === 'language'" class="d-flex align-center ga-3 flex-wrap">
              <span class="text-body-medium font-weight-medium">支持能力：</span>
              <v-checkbox
                v-for="c in capabilityOptions"
                :key="c"
                v-model="modForm.capabilities"
                :value="c"
                :label="c"
                color="primary"
                density="compact"
                hide-details
              />
            </div>

            <v-row density="compact">
              <v-col v-if="modForm.kind === 'language'" cols="12" sm="6" md="4">
                <v-select v-model="modForm.reasoningEffort" label="推理深度 (Reasoning Effort)" :items="reasoningItems" />
              </v-col>
              <v-col v-if="modForm.kind === 'language'" cols="12" sm="6" md="4">
                <v-text-field v-model="modForm.thinkingBudget" label="思考 Token 预算 (可选)" type="number" min="0" placeholder="例如 4096" />
              </v-col>
              <v-col cols="12" :sm="modForm.kind === 'language' ? 6 : 12" :md="modForm.kind === 'language' ? 4 : 6">
                <v-text-field v-model.number="modForm.contextWindow" label="上下文窗口" type="number" min="512" required />
              </v-col>
              <v-col v-if="modForm.kind === 'language'" cols="12" sm="6" md="6">
                <v-text-field v-model.number="modForm.maxOutput" label="最大输出 Token" type="number" min="64" required />
              </v-col>
              <v-col v-if="modForm.kind === 'language'" cols="12" sm="6" md="6">
                <v-text-field v-model="modForm.temperature" label="温度 Temperature (可选)" type="number" step="0.05" min="0" max="2" placeholder="0.8" />
              </v-col>
            </v-row>

            <v-switch v-model="modForm.active" label="启用模型" />
          </v-form>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="modOpen = false">取消</v-btn>
          <v-btn color="primary" type="submit" form="cp-model-form" :loading="modBusy">保存模型</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
