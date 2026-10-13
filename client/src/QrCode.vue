<script setup lang="ts">
import { ref, watch } from 'vue';
import QRCode from 'qrcode';
const props = defineProps<{ value: string; size?: number }>();
const source = ref('');
watch(() => props.value, async value => {
  source.value = '';
  if (!value) return;
  try { const result = await QRCode.toDataURL(value, { width: props.size || 200, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#183d32', light: '#ffffff' } }); if (value === props.value) source.value = result; } catch {}
}, { immediate: true });
</script>
<template><img v-if="source" class="qr-code" :src="source" :width="size || 200" :height="size || 200" alt="扫码加入这间观影室"/><span v-else class="small-muted">正在准备二维码…</span></template>
