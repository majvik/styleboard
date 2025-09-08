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

// утилита для data:URL (для удалённого режима)
export async function blobToDataURL(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
