<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '@/lib/markdown';

const props = defineProps<{
  content: string | null | undefined;
  markdown?: boolean;
  empty?: string;
}>();

const html = computed(() => (props.markdown && props.content ? renderMarkdown(props.content) : ''));
</script>

<template>
  <div class="artifact">
    <p v-if="!content" class="faint">{{ empty ?? 'Nicht vorhanden.' }}</p>
    <!-- eslint-disable-next-line vue/no-v-html -- Inhalt ist über DOMPurify sanitisiert -->
    <div v-else-if="markdown" class="markdown" v-html="html" />
    <pre v-else class="scroll-x">{{ content }}</pre>
  </div>
</template>

<style scoped>
.artifact {
  height: 100%;
  overflow-y: auto;
}
.markdown {
  line-height: 1.6;
}
</style>
