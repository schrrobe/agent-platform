<script setup lang="ts">
defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  checkboxLabel?: string;
  checked?: boolean;
}>();
const emit = defineEmits<{
  confirm: [];
  cancel: [];
  'update:checked': [checked: boolean];
}>();

function updateChecked(event: Event): void {
  emit('update:checked', (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('cancel')">
    <div class="dialog card">
      <h3>{{ title }}</h3>
      <p class="muted">{{ message }}</p>
      <label v-if="checkboxLabel" class="option">
        <input type="checkbox" :checked="checked" @change="updateChecked" />
        <span>{{ checkboxLabel }}</span>
      </label>
      <div class="actions">
        <button @click="emit('cancel')">Abbrechen</button>
        <button :class="{ danger }" class="primary" @click="emit('confirm')">
          {{ confirmLabel ?? 'Bestätigen' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: min(420px, 92vw);
  padding: 20px;
  box-shadow: var(--shadow);
}
.dialog h3 {
  margin: 0 0 8px;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-top: 14px;
  color: var(--text);
  font-size: 13px;
}
.option input {
  width: auto;
  margin-top: 2px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
