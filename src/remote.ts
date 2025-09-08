export type BoardKey = 'moodboard' | 'styleboard';
const API = import.meta.env.VITE_API_BASE || '/api';

export async function remoteLoad(board: BoardKey) {
  try {
    const r = await fetch(`${API}?op=list&board=${board}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.items) ? j.items : null;
  } catch { return null; }
}

let saveTimer: number | undefined;

export async function remoteSave(board: BoardKey, items: any[], pass: string | null) {
  // если пароля нет — просто не отправляем (чтобы не было 401)
  if (!pass) {
    console.warn('[remoteSave] skipped: no password set');
    return;
  }
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const res = await fetch(`${API}?op=save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pass': pass },
      // продублируем пароль в body (сервер его тоже понимает)
      body: JSON.stringify({ board, items, pass })
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>'');
      console.warn('[remoteSave] failed', res.status, t);
    }
  }, 300);
}

// helper: обычное чтение как есть (fallback)
async function readAsDataURL(blob: Blob): Promise<string> {
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ''));
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

/**
 * Сжимает изображение до maxSide (по длинной стороне) и кодирует в JPEG/WebP.
 * Следит, чтобы итоговый data:URL занимал не более maxBytes.
 */
export async function blobToDataURL(
  blob: Blob,
  opts: { maxSide?: number; maxBytes?: number; mime?: 'image/webp'|'image/jpeg'; quality?: number } = {}
): Promise<string> {
  const maxSide  = opts.maxSide  ?? 1440;           // под твой layout
  const maxBytes = opts.maxBytes ?? 1_500_000;      // ~1.5 MB на картинку — безопасно для Netlify
  const prefer   = opts.mime     ?? 'image/jpeg';   // можно сменить на 'image/webp'
  let quality    = opts.quality  ?? 0.85;

  // Не картинка — читаем как есть
  if (!blob.type.startsWith('image/')) return readAsDataURL(blob);

  // 1) Декодируем и масштабируем
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return readAsDataURL(blob); // не смогли — вернём «как есть»

  const srcW = bmp.width, srcH = bmp.height;
  const k = Math.min(1, maxSide / Math.max(srcW, srcH));
  const W = Math.max(1, Math.round(srcW * k));
  const H = Math.max(1, Math.round(srcH * k));

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // JPEG без альфы — заливаем фон белым, чтобы прозрачность не стала чёрной
  if (prefer === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close?.();

  // 2) Кодируем и постепенно уменьшаем качество, пока не уложимся в лимит
  let dataUrl = canvas.toDataURL(prefer, quality);
  let guard = 8;
  const toBytes = (u: string) => Math.floor(u.length * 0.75); // грубая оценка base64→байты

  while (toBytes(dataUrl) > maxBytes && guard-- > 0) {
    quality = Math.max(0.35, quality - 0.15);
    dataUrl = canvas.toDataURL(prefer, quality);
  }

  // 3) Если всё ещё крупно — дополнительно уменьшим геометрию и перекодируем разок
  if (toBytes(dataUrl) > maxBytes) {
    const shrink = Math.min(1, maxSide / 1024); // ещё шаг к ~1024px
    const W2 = Math.max(1, Math.round(W * shrink));
    const H2 = Math.max(1, Math.round(H * shrink));
    if (W2 !== W || H2 !== H) {
      canvas.width = W2; canvas.height = H2;
      if (prefer === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W2, H2); }
      // перерисуем уже уменьшенную картинку
      ctx.drawImage(ctx.canvas, 0, 0, W2, H2);
      dataUrl = canvas.toDataURL(prefer, quality);
    }
  }

  return dataUrl;
}
