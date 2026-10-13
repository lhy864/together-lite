export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '请求失败，请重试', response.status);
  return data;
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
export function clockText(seconds: number) {
  const n = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}
export function sizeText(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`; }
export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  const box = document.createElement('textarea'); box.value = text; box.style.position = 'fixed'; box.style.opacity = '0';
  document.body.appendChild(box); box.select(); const ok = document.execCommand('copy'); box.remove();
  if (!ok) throw new Error('当前浏览器无法复制，请长按链接手动复制');
}
