import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
// Usage: node scripts/make-demo.mjs "C:/path/to/ffmpeg.exe"
const ffmpeg = process.argv[2] || 'ffmpeg';
mkdirSync('media', { recursive: true });
const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path.resolve('media/Together 测试影片.mp4')],
  { stdio: 'inherit', windowsHide: true });
if (result.error) console.error('请先安装 FFmpeg，或把 ffmpeg.exe 路径传给此脚本。');
if (result.status !== 0) process.exitCode = 1;
else console.log('已生成自制 60 秒测试影片（含测试音，请调低音量）。');
