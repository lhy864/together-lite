<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ControlAction, MediaSummary, MemberStatus, RoomState } from '../../shared/protocol';
import { clockText } from './api';
import Icon from './Icon.vue';
const props = defineProps<{ roomId: string; media: MediaSummary; state: RoomState;
  connected: boolean; canControl: boolean; pending: boolean; target: () => number }>();
const emit = defineEmits<{ control: [action: ControlAction, position: number]; status: [status: MemberStatus] }>();
const video = ref<HTMLVideoElement>(), surface = ref<HTMLElement>();
const prepared = ref(false), duration = ref(0), current = ref(0), drift = ref(0), volume = ref(0.8);
const muted = ref(false), captions = ref(true), scrubbing = ref(false), scrub = ref(0), buffering = ref(false);
const problem = ref(''), hint = ref(''), preparing = ref(false), metadata = ref(false);
const mediaUrl = computed(() => `/api/rooms/${props.roomId}/media/${props.media.id}`);
const trackUrl = computed(() => `/api/rooms/${props.roomId}/subtitle/${props.media.id}`);
const position = computed(() => scrubbing.value ? scrub.value : current.value);
let interval: ReturnType<typeof setInterval>, pendingPlay = false, lastSeek = 0;
let lastStatus: MemberStatus | undefined;
function status(s: MemberStatus) { if (s !== lastStatus) { lastStatus = s; emit('status', s); } }
function setCaptions() { if (video.value?.textTracks[0]) video.value.textTracks[0].mode = captions.value ? 'showing' : 'disabled'; }
function readMetadata() {
  metadata.value = true;
  duration.value = Number.isFinite(video.value?.duration) ? video.value!.duration : 0;
  setCaptions(); reconcile(true);
}
function seekTo(target: number) {
  if (!video.value || !metadata.value) return;
  try { video.value.currentTime = Math.min(Math.max(0, target), Math.max(0, duration.value - 0.03)); lastSeek = performance.now(); }
  catch { /* Some browsers reject a seek before metadata is usable. */ }
}
async function playLocal() {
  if (!video.value || pendingPlay || !prepared.value) return;
  pendingPlay = true;
  try { await video.value.play(); }
  catch (e) {
    if ((e as DOMException).name === 'NotAllowedError') { prepared.value = false; status('unready'); hint.value = '浏览器需要你再点击一次「准备观看」'; }
    else if ((e as DOMException).name !== 'AbortError') { problem.value = '无法开始播放，请检查影片编码或网络后重试'; status('error'); }
  } finally { pendingPlay = false; }
}
function reconcile(force = false) {
  const v = video.value;
  if (!v) return;
  if (!props.connected) { v.pause(); v.playbackRate = 1; return; }
  // Let the user's initial play() promise settle before sync can pause or seek it.
  if (preparing.value) return;
  if (!metadata.value || scrubbing.value || problem.value) return;
  const goal = Math.min(props.target(), duration.value || Infinity);
  drift.value = v.currentTime - goal;
  if ((!buffering.value || force) && !v.seeking && (force || performance.now() - lastSeek > 1500)) {
    if (Math.abs(drift.value) > (props.state.playing ? 1.2 : 0.08)) seekTo(goal);
  }
  if (!prepared.value) { v.pause(); v.playbackRate = 1; return; }
  if (!props.state.playing || (duration.value > 0 && goal >= duration.value)) {
    v.pause(); v.playbackRate = 1;
    if (props.state.playing && duration.value > 0 && goal >= duration.value) command('pause', duration.value);
  }
  else {
    v.playbackRate = !buffering.value && Math.abs(drift.value) > 0.18 && Math.abs(drift.value) <= 1.2 ? (drift.value > 0 ? 0.97 : 1.03) : 1;
    if (v.paused && !buffering.value) void playLocal();
  }
}
async function prepare() {
  if (!video.value || preparing.value || !metadata.value || !props.connected) return;
  const selectedMedia = props.media.id;
  preparing.value = true; problem.value = ''; hint.value = ''; seekTo(props.target());
  // This call happens inside the user's click, so mobile browsers can allow audio.
  const attempt = video.value.play();
  try {
    await attempt;
    if (props.media.id !== selectedMedia) return;
    prepared.value = true; status('ready');
    if (!props.state.playing) video.value.pause();
    reconcile(true);
  } catch { if (props.media.id === selectedMedia) { prepared.value = false; hint.value = '播放未能开始，请检查网络，或点击重试'; status('unready'); } }
  finally { if (props.media.id === selectedMedia) { preparing.value = false; reconcile(true); } }
}
function command(action: ControlAction, pos = video.value?.currentTime || 0) {
  if (!props.canControl || !props.connected || props.pending || !prepared.value) return;
  emit('control', action, pos);
}
function commitSeek() { scrubbing.value = false; command('seek', scrub.value); }
function onWaiting() { if (prepared.value && props.state.playing && props.connected) { buffering.value = true; status('buffering'); } }
function onCanPlay() { buffering.value = false; if (prepared.value) status('ready'); reconcile(true); }
function onPlaying() { buffering.value = false; if (prepared.value) status('ready'); }
function onError() { problem.value = '影片无法加载。请检查网络，或确认影片为浏览器支持的 H.264 + AAC MP4。'; status('error'); }
function retry() { problem.value = ''; hint.value = ''; prepared.value = false; metadata.value = false; buffering.value = false; video.value?.load(); status('unready'); }
function end() { if (props.state.playing) command('pause', duration.value); }
function changeVolume(event: Event) { volume.value = Number((event.target as HTMLInputElement).value); if (video.value) { video.value.volume = volume.value; video.value.muted = false; muted.value = false; } }
function toggleMute() { muted.value = !muted.value; if (video.value) video.value.muted = muted.value; }
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if (surface.value?.requestFullscreen) await surface.value.requestFullscreen(); else hint.value = '当前浏览器不支持网页全屏，可横屏观看'; }
  catch { hint.value = '全屏未能打开，可横屏观看'; }
}
watch(() => props.state.version, () => reconcile(true));
watch(() => props.connected, (connected) => {
  lastStatus = undefined;
  if (connected) { buffering.value = false; status(prepared.value ? 'ready' : 'unready'); }
  reconcile(true);
});
watch(() => props.media.id, async () => {
  prepared.value = false; preparing.value = false; metadata.value = false; duration.value = 0; current.value = 0;
  buffering.value = false; problem.value = ''; hint.value = ''; lastStatus = undefined; status('unready');
  await nextTick(); video.value?.load();
});
watch(captions, setCaptions);
onMounted(() => { if (video.value) video.value.volume = volume.value; interval = setInterval(() => reconcile(), 500); status('unready'); });
onUnmounted(() => { clearInterval(interval); video.value?.pause(); });
</script>
<template>
  <div ref="surface" class="player-surface">
    <div class="video-stage">
      <video ref="video" :src="mediaUrl" playsinline preload="metadata" @loadedmetadata="readMetadata" @timeupdate="current = video?.currentTime || 0" @waiting="onWaiting" @canplay="onCanPlay" @playing="onPlaying" @error="onError" @ended="end">
        <track v-if="media.subtitle" :key="media.id" kind="subtitles" :src="trackUrl" srclang="zh" label="影片字幕" default @load="setCaptions" />
      </video>
      <div v-if="problem" class="player-overlay"><Icon name="film" :size="40"/><h3>这一幕暂时没能加载</h3><p>{{ problem }}</p><button class="button ivory" @click="retry">重新加载</button></div>
      <div v-else-if="!connected" class="player-overlay"><span class="spinner"></span><h3>正在连接观影室</h3><p>连接恢复后，自动跟上大家的进度。</p></div>
      <div v-else-if="!prepared" class="player-overlay ready-overlay"><span class="eyebrow">YOUR SEAT IS READY</span><h3>准备好，进入故事。</h3><p>点击一次，让浏览器允许播放声音。<br>随后就能跟随房间同步观看。</p><button class="button ivory" :disabled="!metadata || preparing" @click="prepare"><Icon name="play"/>{{ preparing ? '正在准备…' : metadata ? '准备观看' : '正在读取影片…' }}</button><small v-if="hint">{{ hint }}</small></div>
      <div v-else-if="buffering" class="buffering-indicator"><span class="spinner small"></span>正在缓冲，恢复后会追上大家</div>
      <div v-else-if="!state.playing" class="paused-indicator"><Icon name="pause" :size="14"/>房间已暂停</div>
    </div>
    <div class="player-controls">
      <div class="timeline-row"><span>{{ clockText(position) }}</span><input class="timeline" type="range" min="0" :max="duration || 1" step="0.1" :value="position" :disabled="!canControl || !prepared || !connected || pending" aria-label="播放进度" :style="{ '--progress': `${duration ? position / duration * 100 : 0}%` }" @input="scrubbing = true; scrub = Number(($event.target as HTMLInputElement).value)" @change="commitSeek"/><span>{{ clockText(duration) }}</span></div>
      <div class="control-row"><div class="control-left"><button class="icon-button main-play" :disabled="!prepared || !connected || !canControl || pending" :aria-label="state.playing ? '暂停全房间' : '播放全房间'" @click="command(state.playing ? 'pause' : 'play')"><Icon :name="state.playing ? 'pause' : 'play'" :size="24"/></button><button class="icon-button" :aria-label="muted ? '取消静音' : '静音'" @click="toggleMute"><Icon :name="muted || !volume ? 'mute' : 'volume'"/></button><input class="volume-range" type="range" min="0" max="1" step="0.05" :value="muted ? 0 : volume" aria-label="本机音量" @input="changeVolume"/><span class="player-sync-label">{{ !canControl ? '由房主控制播放' : pending ? '正在同步操作…' : prepared ? '播放操作同步给所有人' : '请先准备观看' }}</span></div><div class="control-right"><span v-if="prepared && connected" class="drift-label">{{ Math.abs(drift) < 0.2 ? '已同步' : `校准中 ${Math.abs(drift).toFixed(1)}s` }}</span><button v-if="media.subtitle" class="caption-button" :class="{ active: captions }" :aria-pressed="captions" aria-label="切换字幕" @click="captions = !captions">CC</button><button class="icon-button" aria-label="全屏" @click="fullscreen"><Icon name="full"/></button></div></div>
    </div>
    <p v-if="prepared && hint" class="player-hint">{{ hint }}</p>
  </div>
</template>
