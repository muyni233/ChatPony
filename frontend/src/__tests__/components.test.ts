import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { VSwitch } from 'vuetify/components';
import { vuetify } from '../plugins/vuetify';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import WavyProgress from '../components/m3/WavyProgress.vue';
import QuotaCard from '../components/QuotaCard.vue';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe('Vuetify 4 MD3 Components', () => {
  it('toggles VSwitch state and emits update', async () => {
    const wrapper = mount(VSwitch, {
      global: { plugins: [vuetify] },
      props: { modelValue: false, label: '启用开关' },
    });
    expect(wrapper.text()).toContain('启用开关');
    const input = wrapper.find('input[type="checkbox"]');
    expect(input.exists()).toBe(true);
    await input.setValue(true);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true]);
  });

  it('renders AvatarBadge fallback initials cleanly', () => {
    const wrapper = mount(AvatarBadge, {
      global: { plugins: [vuetify] },
      props: { name: 'Twilight Sparkle', size: 44 },
    });
    expect(wrapper.text()).toContain('TS');
  });

  it('renders EmptyState title, description, and action slot', () => {
    const wrapper = mount(EmptyState, {
      global: { plugins: [vuetify] },
      props: { title: '暂无会话', description: '挑一个角色开始对话吧。', icon: 'mdi-chat-outline' },
      slots: { action: '<button type="button">立即开启</button>' },
    });
    expect(wrapper.text()).toContain('暂无会话');
    expect(wrapper.text()).toContain('挑一个角色开始对话吧。');
    expect(wrapper.text()).toContain('立即开启');
  });

  it('renders QuotaCard dual windows accurately', () => {
    const wrapper = mount(QuotaCard, {
      global: { plugins: [vuetify] },
      props: {
        quota: {
          fiveHour: { used: 12, limit: 50, remaining: 38, resetsAt: null },
          sevenDay: { used: 40, limit: 500, remaining: 460, resetsAt: null },
        },
      },
    });
    const nums = wrapper.findAll('.cp-quota-big__num').map((n) => n.text());
    expect(nums).toEqual(['38', '460']);
    expect(wrapper.text()).toContain('/ 50 次剩余');
    expect(wrapper.text()).toContain('/ 500 次剩余');
  });

  it('resets AvatarBadge fallback when avatar url changes', async () => {
    const wrapper = mount(AvatarBadge, {
      global: { plugins: [vuetify] },
      props: { name: 'Pinkie Pie', avatar: '/broken.png', size: 40 },
    });
    const img = wrapper.findComponent({ name: 'VImg' });
    expect(img.exists()).toBe(true);
    img.vm.$emit('error');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.cp-avatar__fallback').exists()).toBe(true);

    await wrapper.setProps({ avatar: '/fixed.png' });
    expect(wrapper.find('.cp-avatar__fallback').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'VImg' }).exists()).toBe(true);
  });

  it('renders QuotaCard compact zero-limit bar at 0% and WavyProgress full state cleanly', () => {
    const compact = mount(QuotaCard, {
      global: { plugins: [vuetify] },
      props: {
        compact: true,
        quota: {
          fiveHour: { used: 0, limit: 0, remaining: 0, resetsAt: null },
          sevenDay: { used: 0, limit: 100, remaining: 100, resetsAt: null },
        },
      },
    });
    const fills = compact.findAll('.cp-meter__fill');
    expect(fills[0]?.attributes('style')).toContain('width: 0%');
    expect(fills[1]?.attributes('style')).toContain('width: 100%');

    const fullWave = mount(WavyProgress, {
      global: { plugins: [vuetify] },
      props: { value: 50, max: 50 },
    });
    expect(fullWave.classes()).toContain('is-full');
    expect(fullWave.find('.cp-wavy__track').exists()).toBe(false);
  });
});
