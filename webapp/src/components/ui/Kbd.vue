<!-- apps/kimi-web/src/components/ui/Kbd.vue -->
<!-- Design-system §03 Kbd: keyboard shortcut rendered as quiet outlined
     keycaps — one <kbd> block per key (e.g. ['⌘', 'K'] renders two caps). -->
<script setup lang="ts">
defineProps<{
  keys: string[];
}>();
</script>

<template>
  <span class="ui-kbd">
    <kbd v-for="key in keys" :key="key" class="ui-kbd__key">{{ key }}</kbd>
  </span>
</template>

<style scoped>
.ui-kbd {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.ui-kbd__key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font-family: var(--font-ui);
  font-size: 11px;
  line-height: 1;
}
</style>
