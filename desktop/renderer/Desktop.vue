<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { DesktopSnapshot, DesktopSettings, Diagnosis } from '../../shared/desktop';
import MovieCard from './MovieCard.vue';
import Icon from '../../client/src/Icon.vue';
import QrCode from '../../client/src/QrCode.vue';
const bridge = window.togetherDesktop;
const state = ref<DesktopSnapshot>(), loading = ref(true), busy = ref(''), notice = ref(''), error = ref('');
const tab = ref<'home' | 'connection' | 'settings'>('home'), selected = ref(''), dragging = ref(false);
const roomName = ref('今晚一起看'), inviteRoom = ref(''), inviteUrl = ref(''), shareOrigin = ref(''), copied = ref(false);
const checking = ref(false), diagnosis = ref<Diagnosis>(), settingsSaved = ref(false);
const form = reactive<DesktopSettings>({ nickname: '房主', port: 3001, maxMembers: 4, publicUrl: '', connectionMode: 'direct', autoStart: true });
const movie = computed(() => state.value?.media.find(m => m.id === selected.value));
const running = computed(() => state.value?.status === 'running');
const statusText = computed(() => ({ running: '观影服务已就绪', starting: '正在准备观影服务', stopped: '观影服务已停止', stopping: '正在停止服务', error: '服务需要处理' }[state.value?.status || 'stopped']));
const origins = computed(() => state.value ? [
  ...(state.value.settings.publicUrl ? [{ label: state.value.settings.connectionMode === 'tunnel' ? '外地朋友 · 内网穿透地址' : '外地朋友 · HTTPS 域名', url: state.value.settings.publicUrl }] : []),
  ...(!state.value.settings.publicUrl && state.value.settings.connectionMode !== 'tunnel' ? state.value.network.lan.map(a => ({ label: `${a.virtual ? '其他网络' : '同一局域网'} · ${a.address}`, url: a.url })) : []),
  { label: '仅这台电脑 · 本机体验', url: state.value.network.localUrl },
] : []);
const publicInvite = computed(() => !!state.value?.settings.publicUrl && shareOrigin.value === state.value.settings.publicUrl);
const tunnel = computed(() => state.value?.settings.connectionMode === 'tunnel');
let dispose: (() => void) | undefined, noticeTimer: ReturnType<typeof setTimeout>;
function apply(snapshot: DesktopSnapshot) {
  if (state.value && (state.value.status !== snapshot.status || state.value.settings.publicUrl !== snapshot.settings.publicUrl ||
      state.value.settings.connectionMode !== snapshot.settings.connectionMode || state.value.settings.port !== snapshot.settings.port)) diagnosis.value = undefined;
  state.value = snapshot;
  if (!snapshot.media.some(m => m.id === selected.value)) selected.value = snapshot.media[0]?.id || '';
  if (inviteRoom.value && !snapshot.rooms.some(r => r.id === inviteRoom.value)) inviteRoom.value = '';
}
function flash(text: string) { notice.value = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.value = '', 5000); }
function readable(e: unknown) { return (e instanceof Error ? e.message : '操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
async function action(name: string, task: () => Promise<unknown>) {
  if (busy.value) return; busy.value = name; error.value = '';
  try { const result = await task(); if (result && typeof result === 'object' && 'status' in result) apply(result as DesktopSnapshot); }
  catch (e) { error.value = readable(e); }
  finally { busy.value = ''; }
}
async function dropped(files: File[]) {
  dragging.value = false;
  if (!files.length) return;
  await choose('import', () => bridge.importFiles(files));
}
async function choose(name: string, task: () => Promise<DesktopSnapshot>) {
  const previous = new Set(state.value?.media.map(m => m.id));
  await action(name, async () => {
    const result = await task(); apply(result);
    const added = result.media.find(m => !previous.has(m.id)); if (added) selected.value = added.id;
    return result;
  });
}
async function create() {
  await action('create', async () => {
    const result = await bridge.createRoom(selected.value, roomName.value);
    await showInvite(result.room.id);
  });
}
async function showInvite(id: string) {
  inviteRoom.value = id; copied.value = false;
  shareOrigin.value = origins.value[0]?.url || '';
  inviteUrl.value = await bridge.invite(id, shareOrigin.value);
}
async function changeOrigin() { await action('invite', async () => { inviteUrl.value = await bridge.invite(inviteRoom.value, shareOrigin.value); copied.value = false; }); }
async function copy() { await action('copy', async () => { await bridge.copyInvite(inviteRoom.value, shareOrigin.value); copied.value = true; }); }
async function renew() {
  if (!window.confirm('旧邀请将不能再加入。已经在房间里的朋友可以继续观看。更新邀请？')) return;
  await action('renew', async () => { inviteUrl.value = await bridge.invite(inviteRoom.value, shareOrigin.value, true); copied.value = false; });
}
async function endRoom(id: string) { if (window.confirm('结束这个房间？正在观看的朋友都会离开。')) await action('end', () => bridge.endRoom(id)); }
function showSettings() { if (state.value) Object.assign(form, state.value.settings); settingsSaved.value = false; tab.value = 'settings'; }
async function saveSettings() { await action('settings', async () => { apply(await bridge.settings({ ...form })); Object.assign(form, state.value!.settings); settingsSaved.value = true; flash('设置已保存'); }); }
async function check() {
  checking.value = true; error.value = '';
  try { diagnosis.value = await bridge.diagnose(); }
  catch (e) { error.value = readable(e); }
  finally { checking.value = false; }
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape') inviteRoom.value = ''; }
onMounted(async () => {
  window.addEventListener('keydown', escape);
  if (!bridge) { error.value = '请使用 Together Lite 桌面程序打开这个页面。'; loading.value = false; return; }
  try { apply(await bridge.snapshot()); Object.assign(form, state.value!.settings); dispose = bridge.onSnapshot(apply); }
  catch (e) { error.value = readable(e); }
  finally { loading.value = false; }
});
onUnmounted(() => { dispose?.(); clearTimeout(noticeTimer); window.removeEventListener('keydown', escape); });
</script>
<template>
  <div v-if="loading" class="loading-screen"><span class="brand-mark">t.</span><p>正在准备今晚的观影室…</p></div>
  <div v-else class="desktop-shell">
    <aside class="desktop-sidebar"><div class="brand"><span class="brand-mark">t.</span><span>together <em>lite</em></span></div><span class="desktop-edition">你的私人小影院</span><nav><button :class="{ active: tab === 'home' }" @click="tab = 'home'"><Icon name="film"/>今晚一起看</button><button :class="{ active: tab === 'connection' }" @click="tab = 'connection'"><Icon name="link"/>连接与分享<span v-if="!state?.settings.publicUrl" class="nav-dot"></span></button><button :class="{ active: tab === 'settings' }" @click="showSettings"><Icon name="shield"/>软件设置</button></nav><div class="sidebar-bottom"><div class="sidebar-message"><Icon name="people" :size="24"/><p>一部好电影，<br>几个想一起看的人。</p></div><span>桌面版 0.2.1 <i>·</i> 本地部署</span></div></aside>
    <main class="desktop-main">
      <header class="desktop-topbar"><span>{{ tab === 'home' ? '今晚的放映计划' : tab === 'connection' ? '让朋友找到你的观影室' : '按你的习惯，准备好一切' }}</span><div class="service-pill" :class="{ ready: running, bad: state?.status === 'error' }"><i class="status-dot" :class="{ offline: !running }"></i>{{ statusText }}<button :disabled="!!busy || state?.status === 'starting' || state?.status === 'stopping'" @click="action('service', () => running ? bridge.stop() : bridge.start())">{{ running ? '停止' : '启动' }}</button></div></header>
      <div v-if="error || state?.message" class="notice error" role="alert"><Icon name="shield"/><span>{{ error || state?.message }}</span><button class="button subtle" @click="tab = 'connection'">查看连接</button></div>
      <div v-if="notice" class="desktop-toast" role="status"><Icon name="check" :size="17"/>{{ notice }}</div>
      <template v-if="tab === 'home'">
        <section class="desktop-hero"><div><span class="eyebrow">GOOD FILMS. GOOD COMPANY.</span><h1>今晚，把距离放小一点。</h1><p>选好电影，叫上朋友。你们的观影室随时可以亮灯。</p></div><div class="desktop-hero-art"><span></span><Icon name="play" :size="37"/><small>THIS EVENING<br>TOGETHER</small></div></section>
        <div class="desktop-home-grid"><section class="desktop-library"><div class="section-title"><div><span class="eyebrow">01 / 今晚看什么</span><h2>我的影片 <span class="count">{{ state?.media.length || 0 }}</span></h2></div><div class="library-actions"><button class="button subtle" :disabled="!!busy" @click="action('scan', () => bridge.scan())"><Icon name="refresh" :size="15"/>刷新</button><button class="button primary" :disabled="!!busy" @click="choose('pick', () => bridge.pickFiles())"><Icon name="folder" :size="16"/>选择影片</button></div></div>
          <div class="drop-zone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dropped(Array.from($event.dataTransfer?.files || []))"><Icon name="folder" :size="23"/><div><strong>{{ dragging ? '松开鼠标，添加到片库' : '也可以把影片拖到这里' }}</strong><span>直接读取原文件，选择后就能开房间</span></div><button class="button subtle" :disabled="!!busy" @click="choose('folder', () => bridge.pickDirectory())">添加影片文件夹</button><input class="drop-file-input" type="file" accept="video/mp4,.mp4" multiple aria-label="拖入影片文件" @change="dropped(Array.from(($event.target as HTMLInputElement).files || []))"/></div>
          <div v-if="state?.media.length" class="desktop-movies"><MovieCard v-for="m in state.media" :key="m.id" :movie="m" :selected="selected === m.id" @select="selected = m.id"/></div><div v-else class="empty-state"><Icon name="film" :size="40"/><h3>你的第一场放映，从这里开始</h3><p>点击「选择影片」，找到电脑里的 MP4。<br>无需复制或上传整部电影。</p></div>
          <div v-if="movie" class="movie-actions"><span><Icon name="film" :size="15"/> 已选择：{{ movie.name }}</span><button class="button subtle" :disabled="!!busy" @click="action('subtitle', () => bridge.subtitle(selected))">{{ movie.subtitle ? '更换字幕' : '添加字幕' }}</button><button v-if="movie.removable" class="button subtle" :disabled="!!busy" @click="action('remove', () => bridge.removeMedia(selected))">从片库移除</button></div><p class="library-note"><Icon name="shield" :size="14"/>朋友只会看到房间中的影片。移出片库会保留原文件。</p><div v-for="warning in state?.warnings" :key="warning" class="notice error">{{ warning }}</div>
        </section><aside class="desktop-create"><span class="eyebrow">02 / 给朋友留个位置</span><h2>准备一场放映</h2><p class="muted">{{ state?.settings.nickname }}，今晚想叫上谁？</p><form @submit.prevent="create"><label class="field">观影室的名字<input v-model="roomName" maxlength="50" required placeholder="今晚一起看"/></label><div class="selected-film"><Icon name="film"/><div><span>今晚放映</span><strong>{{ movie?.name || '先选一部喜欢的影片' }}</strong></div></div><button class="button primary wide" :disabled="!movie || !!busy">{{ busy === 'create' ? '正在准备房间…' : '创建并邀请朋友' }}<Icon name="arrow"/></button></form><div class="desktop-three-steps"><p><b>1</b><span>选一部电影<small>从电脑里直接选择</small></span></p><p><b>2</b><span>邀请朋友<small>复制链接，或让朋友扫码</small></span></p><p><b>3</b><span>一起进入故事<small>播放和暂停，会同步给大家</small></span></p></div></aside></div>
        <section v-if="state?.rooms.length" class="desktop-open-rooms"><div class="section-title"><h2>还亮着灯的观影室</h2><span class="small-muted">{{ state.rooms.length }} 间开放中</span></div><article v-for="r in state.rooms" :key="r.id" class="desktop-room-card"><span class="room-icon"><Icon name="play"/></span><div><strong>{{ r.name }}</strong><small>{{ r.media.name }} · {{ r.members }} 人在线</small></div><button class="button subtle" :disabled="!!busy" @click="action('invite', () => showInvite(r.id))"><Icon name="link" :size="16"/>邀请</button><button class="button primary" :disabled="!!busy" @click="action('open', () => bridge.openRoom(r.id))">进入观影</button><button class="icon-button" :disabled="!!busy" aria-label="结束房间" @click="endRoom(r.id)"><Icon name="close" :size="16"/></button></article></section>
      </template>
      <template v-else-if="tab === 'connection'">
        <section class="desktop-page-title"><span class="eyebrow">CONNECTED, IN OUR OWN WAY</span><h1>把朋友，请到这里。</h1><p>网线和 Wi-Fi 都能使用。邀请外地朋友，可以选择 SakuraFrp 内网穿透。</p></section>
        <div class="connection-cards">
          <article><span class="connection-icon"><Icon name="check"/></span><h3>这台电脑</h3><strong>{{ running ? '服务已就绪' : '等待启动' }}</strong><p>选片、开房和本机体验</p></article>
          <article><span class="connection-icon"><Icon name="people"/></span><h3>同一局域网</h3><strong>{{ tunnel || state?.settings.publicUrl ? '使用外网邀请地址' : running && state?.network.lan.length ? '已有分享地址' : '等待网络或服务' }}</strong><p>连接同一路由器的网线和 Wi-Fi 设备</p></article>
          <article class="public-card"><span class="connection-icon"><Icon name="link"/></span><h3>外地朋友</h3><strong>{{ diagnosis?.endpoint ? '入口检查通过' : state?.settings.publicUrl ? '地址已设置，等待检查' : '还需要设置入口' }}</strong><p>{{ tunnel ? '内网穿透 · 朋友无需配置 IPv6' : '公网可用性需要朋友实测' }}</p></article>
        </div>
        <section class="connection-panel">
          <div class="section-title"><div><span class="eyebrow">连接检查</span><h2>一步一步，把入口准备好</h2></div><button class="button primary" :disabled="checking" @click="check"><Icon name="refresh" :class="{ spinning: checking }"/>{{ checking ? '检查中…' : '检查连接' }}</button></div>
          <div v-if="diagnosis" class="diagnosis"><p><Icon :name="diagnosis.local ? 'check' : 'close'" :size="17"/>{{ diagnosis.local ? '本机服务正常' : '本机服务尚未通过检查，请先启动。' }}</p><p><Icon :name="diagnosis.endpoint ? 'check' : 'link'" :size="17"/>{{ diagnosis.externalMessage }}</p><p v-for="note in diagnosis.notes" :key="note" class="diagnosis-note">{{ note }}</p></div>
          <ol v-if="tunnel" class="connection-steps">
            <li><b>1</b><div><h3>在 SakuraFrp 创建 TCP 隧道</h3><p>本地 IP 填 127.0.0.1，本地端口填 {{ state?.settings.port }}。远程端口使用分配值，自动 HTTPS 选择「自动」。</p><div class="tunnel-address"><span>启动器转发到这里</span><code>127.0.0.1:{{ state?.settings.port }}</code></div></div></li>
            <li><b>2</b><div><h3>绑定免费子域名，填入连接地址</h3><p>在 SakuraFrp 管理面板的「子域绑定」绑定这条隧道，等待证书加载并重启隧道。将完整 HTTPS 地址填入软件，包括冒号后的远程端口。</p><button class="button subtle" @click="showSettings">填写穿透地址<Icon name="arrow" :size="16"/></button></div></li>
            <li><b>3</b><div><h3>启动两个软件，再邀请朋友</h3><p>保持 Together Lite 和 SakuraFrp 隧道运行。创建观影室后，复制外网邀请或扫码。朋友用手机流量打开并播放，即可确认外网可用。</p><p class="small-muted">视频会经过 SakuraFrp 节点，流畅度和用量取决于节点带宽及账户额度。</p></div></li>
          </ol>
          <ol v-else class="connection-steps">
            <li><b>1</b><div><h3>选择外地朋友的连接方式</h3><p>已有 SakuraFrp 启动器，可以在软件设置选择「SakuraFrp / 内网穿透」，朋友无需配置 IPv6。</p><button class="button subtle" @click="showSettings">打开公网设置<Icon name="arrow" :size="16"/></button></div></li>
            <li><b>2</b><div><h3>IPv6 直连需要域名和入站访问</h3><p>选择直连时，让域名的 AAAA 记录指向这台电脑；地址变化后需更新 DDNS。路由器与 Windows 防火墙允许 TCP 80/443，软件会准备 HTTPS。</p><div v-if="state?.network.ipv6.length" class="ipv6-list"><code v-for="a in state.network.ipv6" :key="a.address">{{ a.address }}</code></div></div></li>
            <li><b>3</b><div><h3>让朋友用实际网络打开邀请</h3><p>请朋友关闭 Wi-Fi，用移动网络或外地宽带打开邀请并播放，确认访问和视频都正常。</p></div></li>
          </ol>
        </section>
        <section v-if="!tunnel && !state?.settings.publicUrl" class="local-addresses"><h2>这台电脑的局域网地址</h2><p class="small-muted">多块网卡时请选择朋友能够访问的网络。</p><div v-for="a in state?.network.lan" :key="a.address"><span>{{ a.virtual ? '其他网络' : '局域网' }} · {{ a.name }}</span><code>{{ a.url }}</code></div></section>
      </template>
      <template v-else><section class="desktop-page-title"><span class="eyebrow">MAKE YOURSELF AT HOME</span><h1>让下一次打开，更轻松。</h1><p>设置会自动保存在这台电脑，日常使用无需编辑配置文件。</p></section><form class="desktop-settings" @submit.prevent="saveSettings"><section><h2>观影习惯</h2><label class="field">你的昵称<input v-model="form.nickname" required maxlength="30"/></label><label class="field">房间人数（含你自己）<select v-model.number="form.maxMembers"><option :value="2">2 人 · 两个人的电影夜</option><option :value="3">3 人 · 小小的聚会</option><option :value="4">4 人 · 最多四个座位</option></select></label><label class="checkbox-field"><input v-model="form.autoStart" type="checkbox"/><span>打开软件时，自动启动观影服务</span></label></section><section><h2>邀请外地朋友</h2><p class="muted">先选连接方式，再填写朋友能访问的地址。</p>
          <label class="field">外地朋友连接方式<select v-model="form.connectionMode" aria-label="外地朋友连接方式"><option value="tunnel">SakuraFrp / 内网穿透</option><option value="direct">IPv6 + HTTPS 直连</option></select></label>
          <label class="field">{{ form.connectionMode === 'tunnel' ? '穿透外网地址（含远程端口）' : '公网域名（可选）' }}<input v-model="form.publicUrl" :placeholder="form.connectionMode === 'tunnel' ? 'https://你的子域名.nyat.app:远程端口' : '例如 watch.example.com'" aria-label="外网地址" autocomplete="off"/></label>
          <p v-if="form.connectionMode === 'tunnel'" class="small-muted">本地 IP：127.0.0.1 · 本地端口：{{ form.port }}。在 SakuraFrp 开启自动 HTTPS 并绑定免费子域名。这里填写启动器显示的完整 HTTPS 地址；软件无需自行申请证书。</p>
          <p v-else class="small-muted">域名留空时可通过局域网体验。填写后使用内置 HTTPS 入口，仍需配置 IPv6、DNS 与入站访问。</p><details><summary>高级连接设置</summary><label class="field">服务端口<input v-model.number="form.port" type="number" min="1024" max="65535" required/></label><p class="small-muted">SakuraFrp 的本地端口必须与这里相同。建议使用 3001，避免与其他软件冲突。</p></details></section><div class="settings-actions"><button class="button primary" :disabled="!!busy" type="submit">{{ busy === 'settings' ? '正在保存…' : '保存设置' }}<Icon name="check"/></button><span v-if="settingsSaved">已保存，下次打开仍然有效</span><span v-else class="small-muted">连接设置变化时，空闲服务会重新启动。</span></div></form><section class="folder-settings"><div class="section-title"><h2>自动读取的影片文件夹</h2><button class="button subtle" :disabled="!!busy" @click="choose('folder', () => bridge.pickDirectory())"><Icon name="folder" :size="16"/>添加文件夹</button></div><p v-if="!state?.directories.length" class="small-muted">还没有添加文件夹。首页直接选择影片也可以使用。</p><div v-for="directory in state?.directories" :key="directory"><span>{{ directory }}</span><button class="button subtle" :disabled="!!busy" @click="action('folder-remove', () => bridge.removeDirectory(directory))">移除</button></div></section></template>
      <footer class="desktop-footer"><span>{{ tunnel ? '内网穿透模式 · 视频经过 SakuraFrp 节点' : '影片从你的电脑，直接到朋友的浏览器。' }}</span><span>选片 · 邀请 · 一起看</span></footer>
    </main>
    <div v-if="inviteRoom" class="modal-backdrop desktop-modal" @click.self="inviteRoom = ''"><section class="desktop-invite" role="dialog" aria-modal="true" aria-labelledby="desktop-invite-title"><button class="icon-button modal-close" aria-label="关闭邀请窗口" @click="inviteRoom = ''"><Icon name="close"/></button><span class="eyebrow">A SEAT FOR YOUR FRIENDS</span><h2 id="desktop-invite-title">房间好了，叫上朋友。</h2><p class="muted">发一个链接，或者扫一扫，就能坐在一起。</p><div class="desktop-invite-body"><div class="qr-frame"><QrCode :value="inviteUrl" :size="190"/><span>手机相机扫码，加入观影</span></div><div class="invite-right"><label class="field">朋友从哪里加入？<select v-model="shareOrigin" :disabled="!!busy" @change="changeOrigin"><option v-for="o in origins" :key="o.url" :value="o.url">{{ o.label }}</option></select></label><p class="invite-scope">{{ publicInvite ? '已使用外网邀请地址；请朋友用手机流量实际验证。' : shareOrigin === state?.network.localUrl ? '这条链接仅用于当前电脑体验。' : '这条链接适用于同一局域网的朋友，网线和 Wi-Fi 都可以。' }}</p><div class="invite-link"><input :value="inviteUrl" readonly aria-label="邀请链接" @focus="($event.target as HTMLInputElement).select()"/><button class="button primary" :disabled="!!busy" @click="copy"><Icon :name="copied ? 'check' : 'link'" :size="16"/>{{ copied ? '已复制' : '复制' }}</button></div><button class="button primary wide" :disabled="!!busy" @click="action('open', () => bridge.openRoom(inviteRoom))">我先进入观影室<Icon name="arrow"/></button></div></div><div class="invite-bottom"><span>朋友无需安装软件。请把邀请只发给受邀的人。</span><button class="button subtle" :disabled="!!busy" @click="renew">更新邀请</button></div></section></div>
  </div>
</template>
