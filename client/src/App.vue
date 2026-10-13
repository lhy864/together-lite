<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import Host from './Host.vue';
import Room from './Room.vue';
import Icon from './Icon.vue';
import { api, errorText } from './api';
const path = ref(location.pathname), host = ref(false), loading = ref(true), error = ref('');
const initialInvite = ref('');
const roomId = computed(() => /^\/room\/([A-Za-z0-9_-]+)$/.exec(path.value)?.[1]);
function navigate(url: string) { history.pushState({}, '', url); path.value = location.pathname; initialInvite.value = ''; }
function pop() { path.value = location.pathname; }
onMounted(async () => {
  window.addEventListener('popstate', pop);
  const hash = new URLSearchParams(location.hash.slice(1));
  initialInvite.value = hash.get('invite') || '';
  const hostToken = hash.get('host');
  if (location.hash) history.replaceState({}, '', location.pathname + location.search);
  try {
    if (hostToken && path.value === '/host') await api('/api/host/session', { token: hostToken });
    host.value = (await api<{ host: boolean }>('/api/me')).host;
  } catch (e) { error.value = errorText(e); }
  finally { loading.value = false; }
});
onUnmounted(() => window.removeEventListener('popstate', pop));
</script>
<template>
  <div v-if="loading" class="loading-screen"><span class="brand-mark">t.</span><p>正在打开观影室…</p></div>
  <Room v-else-if="roomId" :key="roomId" :room-id="roomId" :invite-token="initialInvite" :is-host="host" @navigate="navigate" />
  <Host v-else-if="host" @navigate="navigate" />
  <div v-else class="welcome-shell">
    <header class="site-header"><a class="brand" href="/"><span class="brand-mark">t.</span><span>together <em>lite</em></span></a><span class="pill">小小的私人观影室</span></header>
    <main class="welcome-card">
      <span class="eyebrow">GOOD FILMS. GOOD COMPANY.</span><h1>隔着距离，<br>也坐在一起。</h1>
      <p>打开朋友发来的邀请链接，选个昵称，<br>就可以一起看电影、暂停、聊天。</p>
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <div v-if="path === '/host'" class="notice"><Icon name="shield" /><span>房主请双击 <strong>.runtime/host-entry.url</strong>，或重新运行 start.cmd。每次启动都会生成新的专用入口。</span></div>
      <div v-else class="notice"><Icon name="link" /><span>加入观影需要邀请链接。<br>如果这台电脑是房主，请运行 start.cmd。</span></div>
      <div class="welcome-footer"><span>本地影片</span><span>同步播放</span><span>2–4 人</span></div>
    </main>
    <footer class="site-footer">Together Lite <span>电影从房主的电脑，直接到你的浏览器。</span></footer>
  </div>
</template>
