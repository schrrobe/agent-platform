import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { JOB_STATES } from '@agent/shared';
import StatusBadge from '@/components/StatusBadge.vue';
import { STATE_LABELS } from '@/lib/labels';

describe('StatusBadge', () => {
  it('rendert das Label für jeden Zustand', () => {
    for (const state of JOB_STATES) {
      const wrapper = mount(StatusBadge, { props: { state } });
      expect(wrapper.text()).toContain(STATE_LABELS[state]);
    }
  });

  it('zeigt „Needs Human" für needs_human', () => {
    const wrapper = mount(StatusBadge, { props: { state: 'needs_human' } });
    expect(wrapper.text()).toContain('Needs Human');
  });
});
