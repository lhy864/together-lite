<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import type { DesktopMedia } from '../../shared/desktop';
import Icon from '../../client/src/Icon.vue';
import { clockText, sizeText } from '../../client/src/api';
const props = defineProps<{ movie: DesktopMedia; selected: boolean }>();
defineEmits<{ select: [] }>();
const poster = ref(''), duration = ref(0), unsupported = ref(false);
let cleanup: (() => void) | undefined;
watch(() => [props.movie.id, props.movie.previewUrl], () => {
  cleanup?.(); unsupported.value = false;
  try { const saved = JSON.parse(localStorage.getItem(`poster:${props.movie.id}`) || '{}'); poster.value = saved.poster || ''; duration.value = saved.duration || 0; } catch {}
  if (!props.movie.previewUrl || poster.value) return;
  const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata';
  const timer = setTimeout(() => { cleanup?.(); }, 15_000);
  cleanup = () => { clearTimeout(timer); v.onloadedmetadata = null; v.onseeked = null; v.onerror = null; v.removeAttribute('src'); v.load(); };
  v.onloadedmetadata = () => { duration.value = Number.isFinite(v.duration) ? v.duration : 0; v.currentTime = Math.min(3, Math.max(.1, duration.value / 4)); };
  v.onseeked = () => {
    try { const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
      const c = canvas.getContext('2d')!; c.fillStyle = '#142b22'; c.fillRect(0, 0, 480, 270);
      const scale = Math.min(480 / v.videoWidth, 270 / v.videoHeight), w = v.videoWidth * scale, h = v.videoHeight * scale;
      c.drawImage(v, (480 - w) / 2, (270 - h) / 2, w, h); poster.value = canvas.toDataURL('image/jpeg', .65);
      try { localStorage.setItem(`poster:${props.movie.id}`, JSON.stringify({ poster: poster.value, duration: duration.value })); } catch {}
    } catch {} finally { cleanup?.(); }
  };
  v.onerror = () => { unsupported.value = true; cleanup?.(); };
  v.src = props.movie.previewUrl;
}, { immediate: true });
onUnmounted(() => cleanup?.());
</script>
<template><button class="desktop-movie" :class="{ selected }" :aria-pressed="selected" @click="$emit('select')"><div class="desktop-poster"><img v-if="poster" :src="poster" alt="影片画面缩略图"/><Icon v-else name="film" :size="43"/><span v-if="movie.demo" class="demo-label">体验影片</span><span v-if="duration" class="duration-tag">{{ clockText(duration) }}</span><span v-if="selected" class="selection-tick"><Icon name="check" :size="15"/></span></div><div class="desktop-film-info"><strong>{{ movie.name }}</strong><span>{{ unsupported ? '此影片可能需要转换格式' : duration ? `${Math.round(duration / 60)} 分钟` : 'MP4 影片' }} · {{ sizeText(movie.size) }} <i v-if="movie.subtitle">· 含字幕</i></span></div></button></template>
