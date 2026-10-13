<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { MediaSummary, Member } from '../../shared/protocol';
import { api, errorText, sizeText } from './api';
import Icon from './Icon.vue';
const emit = defineEmits<{ navigate: [url: string] }>();
type OpenRoom = { id: string; name: string; media: MediaSummary; members: Member[] };
const media = ref<MediaSummary[]>([]), rooms = ref<OpenRoom[]>([]), warnings = ref<string[]>([]);
const selected = ref(''), roomName = ref('今晚一起看'), nickname = ref('房主');
const busy = ref(false), scanning = ref(false), error = ref(''), loaded = ref(false);
async function load(scan = false) {
  scanning.value = true; error.value = '';
  try {
    const result = await api<{ media: MediaSummary[]; warnings: string[] }>(scan ? '/api/host/media/scan' : '/api/host/media', scan ? {} : undefined);
    media.value = result.media; warnings.value = result.warnings;
    if (!media.value.some((m) => m.id === selected.value)) selected.value = media.value[0]?.id || '';
    rooms.value = (await api<{ rooms: OpenRoom[] }>('/api/host/rooms')).rooms;
  } catch (e) { error.value = errorText(e); }
  finally { scanning.value = false; loaded.value = true; }
}
async function create() {
  if (!selected.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api<{ room: { id: string } }>('/api/rooms', { name: roomName.value, nickname: nickname.value, mediaId: selected.value });
    emit('navigate', `/room/${result.room.id}`);
  } catch (e) { error.value = errorText(e); }
  finally { busy.value = false; }
}
async function enter(room: OpenRoom) {
  try { await api(`/api/rooms/${room.id}/join`, { name: nickname.value }); emit('navigate', `/room/${room.id}`); }
  catch (e) { error.value = errorText(e); }
}
onMounted(() => load());
</script>
<template>
  <div class="host-shell">
    <header class="site-header"><a class="brand" href="/host"><span class="brand-mark">t.</span><span>together <em>lite</em></span></a><div class="header-meta"><span class="status-dot"></span> 房主工作台 <span class="pill">V0.1</span></div></header>
    <main>
      <section class="hero"><div><span class="eyebrow">A LITTLE CINEMA, JUST FOR US</span><h1>今晚，看同一部。</h1><p>选一部电影，留几个座位。剩下的，就交给一起看的时间。</p></div><div class="hero-seal"><Icon name="people" :size="27"/><strong>2–4</strong><span>位朋友，刚刚好</span></div></section>
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <div v-for="warning in warnings" :key="warning" class="notice error" role="alert">{{ warning }}</div>
      <div class="host-grid">
        <section class="library-panel">
          <div class="section-title"><div><span class="eyebrow">01 / PICK A FILM</span><h2>你的片库 <span class="count">{{ media.length }}</span></h2></div><button class="button subtle" :disabled="scanning" @click="load(true)"><Icon name="refresh" :class="{ spinning: scanning }"/>{{ scanning ? '扫描中' : '刷新片库' }}</button></div>
          <div v-if="!loaded" class="empty-state">正在读取片库…</div>
          <div v-else-if="!media.length" class="empty-state"><div class="empty-icon"><Icon name="folder" :size="38" /></div><h3>第一场电影，等你放映</h3><p>把 MP4 放进项目的 <code>media</code> 文件夹，<br>然后点击「刷新片库」。</p><span class="small-muted">支持 H.264 + AAC MP4 · 同名 .vtt 字幕</span></div>
          <div v-else class="media-grid"><button v-for="(movie, index) in media" :key="movie.id" class="media-card" :class="{ selected: selected === movie.id }" :aria-pressed="selected === movie.id" @click="selected = movie.id"><div class="film-art" :class="`art-${index % 3}`"><span class="film-number">{{ String(index + 1).padStart(2, '0') }}</span><Icon name="film" :size="44"/><span class="selection-tick" v-if="selected === movie.id"><Icon name="check" :size="16"/></span></div><div class="film-detail"><strong>{{ movie.name }}</strong><span>MP4 <i>·</i> {{ sizeText(movie.size) }} <i v-if="movie.subtitle">·</i> {{ movie.subtitle ? '含字幕' : '' }}</span></div></button></div>
          <p class="library-note"><Icon name="shield" :size="15"/> 仅共享你选中的影片。朋友不会看到磁盘路径或整个片库。</p>
        </section>
        <aside class="create-panel"><span class="eyebrow">02 / SAVE THE SEATS</span><h2>开一间观影室</h2><p class="muted">房间准备好，就可以邀请朋友了。</p><form @submit.prevent="create"><label class="field">房间名字<input v-model="roomName" maxlength="50" required placeholder="今晚一起看" /></label><label class="field">你的昵称<input v-model="nickname" maxlength="30" required placeholder="房主" /></label><div class="selected-film"><Icon name="film"/><div><span>今晚放映</span><strong>{{ media.find(m => m.id === selected)?.name || '先从左边选一部影片' }}</strong></div></div><button class="button primary wide" :disabled="!selected || busy" type="submit">{{ busy ? '准备房间…' : '创建观影室' }}<Icon name="arrow"/></button></form><div class="how-to"><span>接下来很简单</span><p><b>1</b> 复制邀请链接，发给朋友</p><p><b>2</b> 每个人点击「准备观看」</p><p><b>3</b> 开始播放，一起进入故事</p></div></aside>
      </div>
      <section v-if="rooms.length" class="open-rooms"><div class="section-title"><h2>还亮着灯的房间</h2><span class="small-muted">重启程序后，房间会清空</span></div><button v-for="room in rooms" :key="room.id" class="open-room" @click="enter(room)"><span class="room-icon"><Icon name="play"/></span><span><strong>{{ room.name }}</strong><small>{{ room.media.name }} · {{ room.members.length }} 位成员</small></span><Icon name="arrow"/></button></section>
    </main>
    <footer class="site-footer">Together Lite <span>从你的电脑出发，和朋友同步观看。</span><span>本地部署 · 无视频中继</span></footer>
  </div>
</template>
