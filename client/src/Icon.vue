<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  play: 'M8 5v14l11-7z', pause: 'M8 5v14M16 5v14',
  film: 'M4 3h16v18H4zM4 8h16M4 16h16M8 3v18M16 3v18',
  arrow: 'M5 12h14M13 6l6 6-6 6', back: 'M19 12H5M11 6l-6 6 6 6',
  link: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0113 3M18 18a8 8 0 01-13-3',
  people: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-2a4 4 0 00-3-3.87M16 3a4 4 0 010 8',
  chat: 'M21 11.5a8.5 8.5 0 01-8.5 8.5H4l-2 2v-10a8.5 8.5 0 018.5-8.5h2a8.5 8.5 0 018.5 8.5z',
  check: 'M5 12l4 4L19 6', close: 'M6 6l12 12M18 6L6 18',
  volume: 'M11 5L6 9H3v6h3l5 4zM15 8a6 6 0 010 8M18 5a10 10 0 010 14',
  mute: 'M11 5L6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6',
  full: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6',
  folder: 'M3 7V4h6l2 3h10v13H3z', send: 'M22 2L9 15M22 2l-7 20-4-9-9-4z',
};
</script>
<template><svg :width="size || 20" :height="size || 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.film" /></svg></template>
