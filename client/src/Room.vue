<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { ControlAction, MediaSummary, MemberStatus, RoomSnapshot, ServerMessage } from '../../shared/protocol';
import { api, ApiError, copyText, errorText } from './api';
import { SyncClient, type Connection } from './SyncClient';
import Player from './Player.vue';
import Icon from './Icon.vue';
import QrCode from './QrCode.vue';
const props = defineProps<{ roomId: string; inviteToken: string; isHost: boolean }>();
const emit = defineEmits<{ navigate: [url: string] }>();
const room = ref<RoomSnapshot>(), loading = ref(true), error = ref(''), notice = ref(''), closed = ref('');
const preview = ref<{ name: string; mediaName: string; maxMembers: number }>();
const nickname = ref(localStorage.getItem('together_nickname') || ''), joining = ref(false);
const connection = ref<Connection>('connecting'), pending = ref(''), text = ref('');
const chatList = ref<HTMLElement>(), inviteOpen = ref(false), invite = ref(''), shareOrigin = ref('');
const origins = ref<{ label: string; url: string }[]>([]), copied = ref(false), mediaChoices = ref<MediaSummary[]>([]);
const selectedMedia = ref(''), settingsBusy = ref(false);
let client: SyncClient | undefined, pendingTimeout: ReturnType<typeof setTimeout>, noticeTimeout: ReturnType<typeof setTimeout>;
let checking = false;
const host = computed(() => room.value?.me.role === 'host');
const canControl = computed(() => !!room.value && (host.value || room.value.controlMode === 'everyone'));
const shareUrl = computed(() => { if (!invite.value) return ''; const u = new URL(invite.value); return `${shareOrigin.value || u.origin}${u.pathname}${u.hash}`; });
const statusNames: Record<MemberStatus, string> = { ready: '准备好了', unready: '等待准备', buffering: '正在缓冲', error: '播放异常' };
function flash(message: string) { notice.value = message; clearTimeout(noticeTimeout); noticeTimeout = setTimeout(() => notice.value = '', 5000); }
function clearPending() { pending.value = ''; clearTimeout(pendingTimeout); }
function message(m: ServerMessage) {
  if (m.type === 'snapshot') { room.value = m.room; clearPending(); selectedMedia.value = m.room.media.id; }
  else if (m.type === 'state' && room.value) {
    if (m.state.version >= room.value.state.version) { room.value.state = m.state; room.value.media = m.media; selectedMedia.value = m.media.id; }
    if (m.commandId === pending.value) clearPending();
  } else if (m.type === 'members' && room.value) room.value.members = m.members;
  else if (m.type === 'chat' && room.value) { room.value.messages.push(m.message); if (room.value.messages.length > 100) room.value.messages.shift(); void scrollChat(); }
  else if (m.type === 'settings' && room.value) room.value.controlMode = m.controlMode;
  else if (m.type === 'error') { if (m.commandId === pending.value) clearPending(); flash(m.message); }
  else if (m.type === 'closed') { closed.value = m.reason; client?.stop(); }
}
function connectionChanged(state: Connection) {
  connection.value = state;
  if (state !== 'connected') clearPending();
  if (state === 'reconnecting' && !checking && !closed.value) {
    checking = true;
    api(`/api/rooms/${props.roomId}`).catch((e) => {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { closed.value = e.message; client?.stop(); }
    }).finally(() => checking = false);
  }
}
function connect() { client = new SyncClient(props.roomId, message, connectionChanged); client.connect(); }
function control(action: ControlAction, position: number) {
  if (!room.value || !client || pending.value) return;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''); pending.value = id;
  if (!client.send({ type: 'control', action, position, videoId: room.value.media.id, baseVersion: room.value.state.version, commandId: id })) { clearPending(); flash('同步连接暂时断开，正在重连'); return; }
  pendingTimeout = setTimeout(() => { clearPending(); flash('操作未得到确认，正在重新同步'); void refreshState(); }, 5000);
}
async function refreshState() { try { room.value = (await api<{ room: RoomSnapshot }>(`/api/rooms/${props.roomId}`)).room; } catch (e) { flash(errorText(e)); } }
function memberStatus(status: MemberStatus) { client?.send({ type: 'status', status }); }
function targetPosition() { return room.value && client ? client.target(room.value.state) : 0; }
async function scrollChat() { await nextTick(); if (chatList.value) chatList.value.scrollTop = chatList.value.scrollHeight; }
function chat() {
  const value = text.value.trim(); if (!value) return;
  if (client?.send({ type: 'chat', text: value })) text.value = ''; else flash('连接恢复后就可以聊天');
}
async function join() {
  joining.value = true; error.value = '';
  try { room.value = (await api<{ room: RoomSnapshot }>(`/api/rooms/${props.roomId}/join`, { name: nickname.value || '朋友', token: props.inviteToken })).room; localStorage.setItem('together_nickname', nickname.value || '朋友'); connect(); }
  catch (e) { error.value = errorText(e); }
  finally { joining.value = false; }
}
async function inviteDialog() {
  try {
    const [link, network] = await Promise.all([api<{ inviteUrl: string }>(`/api/rooms/${props.roomId}/invite`), api<{ origins: { label: string; url: string }[] }>('/api/host/network')]);
    invite.value = link.inviteUrl; origins.value = network.origins;
    if (!shareOrigin.value) shareOrigin.value = network.origins[0]?.url || location.origin;
    copied.value = false; inviteOpen.value = true;
  } catch (e) { flash(errorText(e)); }
}
async function copyInvite() { try { await copyText(shareUrl.value); copied.value = true; } catch (e) { flash(errorText(e)); } }
async function renewInvite() {
  if (!window.confirm('更新后，旧邀请链接将不能再加入。已加入的朋友会继续观看。')) return;
  try { invite.value = (await api<{ inviteUrl: string }>(`/api/rooms/${props.roomId}/invite`, {})).inviteUrl; copied.value = false; }
  catch (e) { flash(errorText(e)); }
}
async function mode(event: Event) {
  try { await api(`/api/rooms/${props.roomId}/settings`, { controlMode: (event.target as HTMLSelectElement).value }); }
  catch (e) { flash(errorText(e)); }
}
async function switchMedia() {
  if (!selectedMedia.value || selectedMedia.value === room.value?.media.id) return;
  if (!window.confirm('换片会暂停房间、回到开头，所有人需要重新准备观看。')) { selectedMedia.value = room.value!.media.id; return; }
  settingsBusy.value = true;
  try { await api(`/api/rooms/${props.roomId}/media`, { mediaId: selectedMedia.value }); }
  catch (e) { flash(errorText(e)); }
  finally { settingsBusy.value = false; }
}
async function remove(id: string, name: string) {
  if (!window.confirm(`将 ${name} 移出房间？`)) return;
  try { await api(`/api/rooms/${props.roomId}/remove`, { memberId: id }); } catch (e) { flash(errorText(e)); }
}
async function leave() {
  client?.stop();
  try { await api(`/api/rooms/${props.roomId}/leave`, {}); } catch { /* Navigation still succeeds if the room has closed. */ }
  emit('navigate', props.isHost ? '/host' : '/');
}
async function close() {
  if (!window.confirm('结束本次观影？所有朋友都会离开房间。')) return;
  try { await api(`/api/rooms/${props.roomId}/close`, {}); closed.value = '本次观影已结束'; client?.stop(); }
  catch (e) { flash(errorText(e)); }
}
function resume() { if (document.visibilityState === 'visible' && room.value && !closed.value) void refreshState(); }
onMounted(async () => {
  document.addEventListener('visibilitychange', resume);
  try {
    room.value = (await api<{ room: RoomSnapshot }>(`/api/rooms/${props.roomId}`)).room;
    connect();
  } catch {
    try {
      if (props.isHost) { room.value = (await api<{ room: RoomSnapshot }>(`/api/rooms/${props.roomId}/join`, { name: '房主' })).room; connect(); }
      else if (props.inviteToken) preview.value = await api(`/api/rooms/${props.roomId}/preview`, { token: props.inviteToken });
      else error.value = '需要完整邀请链接才能加入。请向房主获取邀请，或确认房间是否仍在开放。';
    } catch (e) { error.value = errorText(e); }
  } finally {
    loading.value = false;
    if (props.isHost && room.value) {
      try { mediaChoices.value = (await api<{ media: MediaSummary[] }>('/api/host/media')).media; selectedMedia.value = room.value.media.id; } catch {}
    }
    void scrollChat();
  }
});
onUnmounted(() => { client?.stop(); clearTimeout(pendingTimeout); clearTimeout(noticeTimeout); document.removeEventListener('visibilitychange', resume); });
</script>
<template>
  <div v-if="loading" class="loading-screen"><span class="brand-mark">t.</span><p>正在找到你的座位…</p></div>
  <div v-else-if="closed || !room" class="welcome-shell"><header class="site-header"><a class="brand" href="/"><span class="brand-mark">t.</span><span>together <em>lite</em></span></a><span class="pill">朋友的邀请</span></header><main class="join-card"><span class="eyebrow">{{ closed ? 'UNTIL NEXT TIME' : 'A SEAT FOR YOU' }}</span><h1>{{ closed ? '下次，再一起看。' : preview?.name || '你的位置，留好了。' }}</h1><p v-if="preview">今晚放映 · {{ preview.mediaName }}</p><p v-if="closed">{{ closed }}</p><div v-if="error" class="notice error" role="alert">{{ error }}</div><form v-if="preview && !closed" @submit.prevent="join"><label class="field">大家怎么称呼你？<input v-model="nickname" required maxlength="30" placeholder="输入你的昵称" autocomplete="nickname" /></label><button class="button primary wide" :disabled="joining" type="submit">{{ joining ? '正在加入…' : '进入观影室' }}<Icon name="arrow"/></button><small class="small-muted">无需注册 · 最多 {{ preview.maxMembers }} 人（含房主）</small></form><button v-else class="button primary" @click="emit('navigate', isHost ? '/host' : '/')">{{ isHost ? '回到房主工作台' : '返回首页' }}</button></main></div>
  <div v-else class="room-shell"><header class="room-header"><button class="brand room-brand" @click="leave"><span class="brand-mark">t.</span><span>together <em>lite</em></span></button><div class="room-heading"><strong>{{ room.name }}</strong><span><i class="status-dot" :class="{ offline: connection !== 'connected' }"></i>{{ connection === 'connected' ? '同步连接正常' : '正在恢复同步连接' }}</span></div><button v-if="host" class="button room-invite" @click="inviteDialog"><Icon name="link"/>邀请朋友</button><button v-else class="button room-invite" @click="leave">离开房间</button></header>
    <div v-if="notice" class="toast" role="status">{{ notice }}</div>
    <main class="room-layout"><section class="watch-column"><Player :room-id="roomId" :media="room.media" :state="room.state" :connected="connection === 'connected'" :can-control="canControl" :pending="!!pending" :target="targetPosition" @control="control" @status="memberStatus"/><div class="now-showing"><div><span class="eyebrow">NOW SHOWING</span><h1>{{ room.media.name }}</h1></div><span class="format-tag">MP4 {{ room.media.subtitle ? '· 字幕' : '' }}</span></div><p class="watch-note"><Icon name="people" :size="16"/>{{ room.controlMode === 'everyone' ? '大家都可以播放、暂停和拖动进度。' : '播放进度由房主控制。' }} 音量和字幕只影响你自己。</p><div v-if="host" class="host-tools"><label>播放权限<select :value="room.controlMode" @change="mode"><option value="everyone">所有成员可控制</option><option value="host">仅房主可控制</option></select></label><label v-if="mediaChoices.length">切换影片<select v-model="selectedMedia" :disabled="settingsBusy" @change="switchMedia"><option v-for="m in mediaChoices" :key="m.id" :value="m.id">{{ m.name }}</option></select></label><button class="button danger" @click="close">结束观影</button></div></section>
      <aside class="social-panel"><section class="members-panel"><div class="panel-title"><h2><Icon name="people"/>一起看的人</h2><span>{{ room.members.length }} 位</span></div><div v-for="(member, index) in room.members" :key="member.id" class="member-row"><span class="avatar" :class="`avatar-${index % 4}`">{{ member.name.slice(0, 1) }}</span><div class="member-info"><strong>{{ member.name }} <span v-if="member.id === room.me.id" class="you-label">你</span><span v-if="member.role === 'host'" class="host-label">房主</span></strong><span><i class="status-dot" :class="{ offline: !member.online, buffering: member.status === 'buffering' }"></i>{{ !member.online ? '暂时离线' : statusNames[member.status] }}</span></div><button v-if="host && member.role !== 'host'" class="icon-button remove-member" :aria-label="`移出 ${member.name}`" @click="remove(member.id, member.name)"><Icon name="close" :size="14"/></button></div><p class="members-note">有人缓冲时，其他人继续观看；<br>恢复后会自动追上房间进度。</p></section><section class="chat-panel"><div class="panel-title"><h2><Icon name="chat"/>边看边聊</h2><span>轻声一点，也没关系</span></div><div ref="chatList" class="chat-list" aria-live="polite" aria-relevant="additions"><div v-if="!room.messages.length" class="chat-empty"><Icon name="chat" :size="30"/><p>故事开始前，<br>先和朋友打个招呼吧。</p></div><div v-for="m in room.messages" :key="m.id" class="chat-message" :class="{ mine: m.memberId === room.me.id }"><div class="message-meta"><strong>{{ m.name }}</strong><time>{{ new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time></div><p>{{ m.text }}</p></div></div><form class="chat-form" @submit.prevent="chat"><input v-model="text" maxlength="500" placeholder="说点什么…" aria-label="聊天消息" :disabled="connection !== 'connected'"/><button class="icon-button send-button" type="submit" aria-label="发送消息" :disabled="!text.trim() || connection !== 'connected'"><Icon name="send" :size="19"/></button></form></section></aside>
    </main><footer class="room-footer">每一帧，都有人陪你看。<span>Together Lite · 影片由房主直接提供</span></footer>
    <div v-if="inviteOpen" class="modal-backdrop" @click.self="inviteOpen = false"><section class="invite-dialog" role="dialog" aria-modal="true" aria-labelledby="invite-title"><button class="icon-button modal-close" aria-label="关闭邀请窗口" @click="inviteOpen = false"><Icon name="close"/></button><span class="eyebrow">SAVE THEM A SEAT</span><h2 id="invite-title">叫上朋友，一起看。</h2><p class="muted">朋友打开链接，输入昵称就能加入。</p><label class="field">朋友使用的入口<select v-model="shareOrigin" @change="copied = false"><option v-for="o in origins" :key="o.url" :value="o.url">{{ o.label }}</option></select></label><div class="invite-link"><input :value="shareUrl" readonly aria-label="邀请链接" @focus="($event.target as HTMLInputElement).select()"/><button class="button primary" @click="copyInvite"><Icon :name="copied ? 'check' : 'link'"/>{{ copied ? '已复制' : '复制' }}</button></div><div class="room-qr"><QrCode :value="shareUrl" :size="180"/><span>手机相机扫码加入</span></div><p class="small-muted">局域网地址用于同一网络中的设备。外地朋友需要已验证可达的公网 HTTPS 入口。请把链接只发给受邀的人。</p><button class="button subtle renew-invite" @click="renewInvite"><Icon name="refresh" :size="16"/>更新邀请，让旧链接失效</button></section></div>
  </div>
</template>
<style scoped>
.room-qr{display:flex;flex-direction:column;align-items:center;background:white;border:1px solid #e2e8d6;border-radius:9px;width:202px;margin:22px auto 18px;padding:6px}.room-qr span{font-size:10px;color:#8b9c73;padding-bottom:10px}
</style>
