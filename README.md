# Together Lite

本地部署的 2～4 人同步观影工具。房主选择电脑上的 MP4，朋友通过手机或电脑浏览器加入，一起播放、暂停、拖动进度和聊天。

视频按需传输原文件，不进行二次视频编码。公网入口可以使用 SakuraFrp 等内网穿透，也可以使用 IPv6 + HTTPS 直连。

## 下载与使用

**Windows x64 桌面版 0.2.1：**

- [下载免安装版](https://github.com/lhy864/together-lite/releases/download/v0.2.1/Together.Lite.0.2.1.exe)
- [下载安装版](https://github.com/lhy864/together-lite/releases/download/v0.2.1/Together.Lite.Setup.0.2.1.exe)
- [发布说明与校验文件](https://github.com/lhy864/together-lite/releases/tag/v0.2.1)
- [使用指南](用户指南.md) · [功能与原理说明](功能与原理说明.md) · [更新记录](CHANGELOG.md)

桌面版包含 Electron / Node.js 运行环境、Caddy 和自制体验影片，无需另行安装 Node.js。首次版本支持 Windows x64；Linux 和 macOS 暂未提供安装包。

打开软件 → 选择影片 → 创建房间 → 复制邀请链接或扫码 → 每人点击「准备观看」。

安装包尚无发布者数字签名，目前没有自动更新功能。

## 当前功能

- 原生文件选择、拖入影片、添加影片文件夹、缩略图和时长。
- MP4 在线播放、WebVTT 字幕、原文件 HTTP Range 传输。
- 邀请链接和二维码、2～4 人房间、仅房主控制或全员控制。
- 同步播放 / 暂停 / 跳转、文字聊天、成员状态、断线重连。
- 服务启停、连接检查、软件设置和影片列表持久化。
- SakuraFrp TCP + 自动 HTTPS，或 Caddy + IPv6 直连。

暂未实现：网页视频链接播放、屏幕共享、语音、各自本地文件模式、自动转码、托盘和自动 DDNS。

## 公网访问

### SakuraFrp / 内网穿透

1. 在软件设置中选择「SakuraFrp / 内网穿透」，默认本地服务端口为 `3001`。
2. 创建 TCP 隧道：本地 IP `127.0.0.1`，本地端口 `3001`，远程端口由服务商分配。
3. 按服务商说明开启自动 HTTPS、绑定子域名并完成证书配置。
4. 将完整的 `https://你的域名:远程端口` 填入软件，保留远程端口。
5. 检查连接，再让朋友用实际外部网络验证网页和视频播放。

穿透模式不要求朋友支持 IPv6，也不启动 Caddy。视频经过穿透节点，上行带宽、账户额度、节点负载和朋友网络都会影响观看。

### IPv6 + HTTPS 直连

使用自己的域名 / DDNS，让 AAAA 记录指向房主电脑的全球 IPv6 地址。软件选择直连模式并填写 HTTPS 域名，使用内置 Caddy 提供入口。仍需正确配置 DNS、路由器与 Windows 防火墙，并满足证书验证的端口要求。

房主有 IPv6 不代表每位朋友的网络都能访问 IPv6。部署步骤见 [使用指南](用户指南.md)。

## 源码开发

技术栈：Vue 3、TypeScript、Node.js、Fastify、ws、Electron；Caddy 提供可选的 HTTPS 入口。

需要 Node.js `22.12` 或更新版本；发布前使用 Node.js 24 验证。

```powershell
npm ci
npm run build
npm test
npm run desktop
```

开发桌面版使用默认 `3001` 端口。脚本 / 网页模式：

```powershell
npm run build
npm start
```

脚本模式默认 `http://localhost:3000`。也可双击 `start.cmd`，它会安装依赖、构建并打开房主入口。不要同时启动多个占用同一端口的实例。

房主管理入口包含管理权限，保存于 `.runtime/host-entry.url`；朋友使用房间邀请链接。

### 准备影片

`media/` 中仅附带自制 60 秒测试影片和字幕，不包含第三方电影。实际影片推荐 H.264 视频、AAC 音频、8 bit yuv420p 和 faststart 的 MP4。软件运行期间不自动转码。

已有影片目录可在桌面界面添加，或复制 `config.local.example.json` 为 `config.local.json` 并设置 `mediaDirectories`。只扫描目录的直接子文件，不递归扫描，不允许访客任意指定磁盘路径。

需要手动转换时，例如：

```powershell
ffmpeg -i input.mkv -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart output.mp4
```

若原有音视频编码已兼容，可使用 `-c copy` 重新封装。同名 UTF-8 `.vtt` 字幕会自动关联。自制测试片的生成脚本是 `scripts/make-demo.mjs`。

### 构建 Windows 安装包

先从 [Caddy 官方发布页](https://github.com/caddyserver/caddy/releases/tag/v2.11.7) 下载 Windows amd64 二进制，放到 `tools/caddy.exe`。第三方许可文件已保留在 `tools/CADDY-LICENSE`。

```powershell
npm run package:win
```

生成的免安装版和 NSIS 安装版位于 `release/`。源码不提交构建目录或 Caddy 二进制。

## 房间与同步规则

- 默认最多 4 人，包含房主；可设置为 2～4 人。
- 服务端维护播放状态与版本，过期操作会被拒绝并刷新状态。
- 小幅进度差异通过轻微调速校正，大幅差异通过定位校正，不保证逐帧一致。
- 一个人缓冲时不会自动暂停全房间；需要等人时主动暂停。
- 音量、字幕开关、全屏仅影响自己。
- 断线时暂停，重连获取完整状态；离线访客保留席位 2 分钟。
- 更新邀请影响后续加入；结束房间、停止服务或退出软件会断开观影。
- 房间、聊天和会话存于内存，重启后清空；桌面设置和影片列表保存在用户数据目录。

## 验证与实际限制

发布前完成 19 项自动测试；此前还完成打包桌面流程 16 项、免安装 EXE 流程 5 项、实际 SakuraFrp HTTPS 浏览器流程 10 项、桌面穿透流程 7 项。

自动测试覆盖 Range / HEAD / 416、文件权限、邀请与会话、人数上限、WebSocket 来源、同步操作竞争、重连、穿透设置、HTTPS 会话和端口冲突。源码可通过 `npm run build` 和 `npm test` 复现自动检查。

手机视口检查使用桌面浏览器模拟；已有实际访问反馈不能替代真实手机长时间观影、多运营商与高码率影片的完整验证。包含实际地址或邀请信息的本地截图、运行记录不纳入公开仓库。

原片传输不会根据网络自动降清晰度。平均 4 Mbps 的影片供三位远端朋友观看，平均上行需求约 12 Mbps，还要预留峰值和协议开销。房主电脑需要保持开机，避免睡眠和断网。

## 源码目录

| 目录 | 职责 |
|---|---|
| `client/` | 浏览器播放器、房间、聊天和同步客户端 |
| `server/` | 房间 API、权限、原文件传输与 WebSocket |
| `desktop/` | 桌面窗口、文件选择、服务管理和桌面界面 |
| `shared/` | 消息协议与共享类型 |
| `tests/` | 自动测试 |
| `media/` | 自制体验影片和媒体说明 |
| `scripts/` | 启动与测试片生成脚本 |

第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

参考：[HTTP Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)、[浏览器自动播放](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)、[Caddy HTTPS](https://caddyserver.com/docs/automatic-https)、[SakuraFrp Web 穿透](https://doc.natfrp.com/app/http.html)。
