// netlify/functions/api.ts
import type { Handler } from '@netlify/functions';

// AWS SDK signs browser uploads to Cloudflare R2.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const WRITE_PASSWORD = process.env.WRITE_PASSWORD!;
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || '';

// Cloudflare R2 configuration
const R2_ENDPOINT = process.env.R2_ENDPOINT || (CF_ACCOUNT_ID ? `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
const R2_REGION = process.env.R2_REGION || 'auto';

// R2 uses the S3 API with path-style bucket addressing.
const s3 = new S3Client({
  region: R2_REGION,
  credentials: { accessKeyId: R2_ACCESS_KEY || 'unconfigured', secretAccessKey: R2_SECRET_KEY || 'unconfigured' },
  endpoint: R2_ENDPOINT || undefined,
  forcePathStyle: true,
});

async function d1Query(sql: string, params: unknown[] = []) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DATABASE_ID) throw new Error('Cloudflare D1 is not configured');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const result = await response.json() as { success?: boolean; errors?: Array<{ message?: string }>; result?: Array<{ results?: any[] }> };
  if (!response.ok || !result.success) throw new Error(result.errors?.[0]?.message || `D1 request failed (${response.status})`);
  return result.result?.[0]?.results || [];
}
async function d1Batch(batch: Array<{ sql: string; params?: unknown[] }>) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DATABASE_ID) throw new Error('Cloudflare D1 is not configured');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch }),
  });
  const result = await response.json() as { success?: boolean; errors?: Array<{ message?: string }>; result?: Array<{ success?: boolean; results?: any[] }> };
  if (!response.ok || !result.success || result.result?.some(statement => statement.success === false)) throw new Error(result.errors?.[0]?.message || `D1 batch failed (${response.status})`);
  return result.result || [];
}

const ENSURE_SCHEMA = `CREATE TABLE IF NOT EXISTS sb_items (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL CHECK (board IN ('moodboard', 'styleboard')),
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'site')),
  gx INTEGER NOT NULL,
  gy INTEGER NOT NULL,
  gw INTEGER NOT NULL,
  gh INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  natw REAL,
  nath REAL,
  natr REAL
);\nCREATE INDEX IF NOT EXISTS sb_items_board_id ON sb_items(board, id);`;
async function ensureD1Schema() { await d1Query(ENSURE_SCHEMA); }

type BoardKey = 'moodboard' | 'styleboard';

function pickHeader(headers: Record<string,string|undefined>, name: string) {
  const n = name.toLowerCase();
  for (const [k,v] of Object.entries(headers || {})) if (k.toLowerCase() === n) return v;
  return undefined;
}

function cryptoRandom() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export const handler: Handler = async (event) => {
  const url = new URL(event.rawUrl);
  const op = url.searchParams.get('op') || 'list';

  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return ok(200, '', { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-pass', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  }

  try {
    // ─────────────────────────────────────────────────────────────
    // 1) ПОДПИСЬ ЗАГРУЗКИ В S3 (Supabase Storage S3-совместимый)
    // ─────────────────────────────────────────────────────────────
    if (op === 'sign-upload' && event.httpMethod === 'POST') {
      const pass = pickHeader(event.headers as any, 'x-pass') || '';
      if (!process.env.WRITE_PASSWORD || pass !== process.env.WRITE_PASSWORD) {
        return { statusCode: 401, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized' }) };
      }

      // Проверяем, что S3 переменные определены
      if (!R2_ENDPOINT || !R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_BUCKET || !R2_PUBLIC_URL) {
        return { statusCode: 503, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Cloudflare R2 is not configured' }) };
      }

      const body = event.body ? JSON.parse(event.body) : {};
      const board: BoardKey = body.board === 'styleboard' ? 'styleboard' : 'moodboard';
      const id: string = body.id || cryptoRandom();
      const mime: string = typeof body.mime === 'string' && body.mime ? body.mime : 'application/octet-stream';
      if (!/^(image|video)\/[a-z0-9.+-]+$/i.test(mime)) return err(400, 'Only image and video uploads are supported');
      const subtype = mime.split('/')[1].toLowerCase();
      const ext = subtype === 'jpeg' ? 'jpg' : subtype === 'quicktime' ? 'mov' : subtype === 'x-msvideo' ? 'avi' : subtype === 'x-matroska' ? 'mkv' : subtype;
      const objectKey = `${board}/${id}.${ext}`;

      // Подписываем однократный PUT на 5 минут
      const cmd = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: objectKey,
        ContentType: mime,
      });
      const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 });

      // Публичный URL (для чтения) через Supabase public endpoint:
      const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${objectKey}`;

      return {
        statusCode: 200,
        headers: { ...cors(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedUrl, publicUrl, id, objectKey })
      };
    }

    // ─────────────────────────────────────────────────────────────
    // 2) CRUD в БД (как и раньше)
    // ─────────────────────────────────────────────────────────────
    if (op === 'list') {
      const board = url.searchParams.get('board');
      if (!board) return err(400, 'board is required');

      if (board !== 'moodboard' && board !== 'styleboard') return err(400, 'invalid board');
      await ensureD1Schema();
      const rows = await d1Query(`SELECT id, board, url, kind, gx, gy, gw, gh, approved, natw AS natW, nath AS natH, natr AS natR FROM sb_items WHERE board = ? ORDER BY id`, [board]);
      return ok(200, JSON.stringify({ items: rows }), cors());
    }

    if (op === 'clear') {
      const pass = event.headers['x-pass'] || (event.body && JSON.parse(event.body||'{}').pass);
      if (pass !== WRITE_PASSWORD) return err(401, 'Unauthorized');

      const board = url.searchParams.get('board'); // можно указать конкретный
      if (board && board !== 'moodboard' && board !== 'styleboard') return err(400, 'invalid board');
      await ensureD1Schema();
      if (board) {
        await d1Query(`DELETE FROM sb_items WHERE board = ?`, [board]);
      } else {
        await d1Query(`DELETE FROM sb_items`);
      }
      return ok(200, JSON.stringify({ ok: true }), cors());
    }

    if (op === 'save') {
      const pass = event.headers['x-pass'] || (event.body && JSON.parse(event.body||'{}').pass);
      if (pass !== WRITE_PASSWORD) return err(401, 'Unauthorized');

      const { board, items } = JSON.parse(event.body || '{}');
      if (!board) return err(400, 'board is required');
      if (board !== 'moodboard' && board !== 'styleboard') return err(400, 'invalid board');
      if (!Array.isArray(items)) return err(400, 'items must be an array');
      if (!items.every((it: any) => it && typeof it === 'object' && typeof it.url === 'string' && (it.url.startsWith('http://') || it.url.startsWith('https://') || it.url.startsWith('idb://') || it.url.startsWith('data:image/')) && (it.kind === 'image' || it.kind === 'video' || it.kind === 'site'))) {
        return err(400, 'Invalid item; use an external URL or supported media reference');
      }

      await ensureD1Schema();
      const batch = [
        { sql: `DELETE FROM sb_items WHERE board = ?`, params: [board] },
        ...items.map((it: any) => ({
          sql: `INSERT INTO sb_items (id, board, url, kind, gx, gy, gw, gh, approved, natw, nath, natr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [it.id, board, it.url, it.kind, it.gx, it.gy, it.gw, it.gh, it.approved ? 1 : 0, it.natW ?? null, it.natH ?? null, it.natR ?? null],
        })),
      ];
      await d1Batch(batch);
      return ok(200, JSON.stringify({ ok: true }), cors());
    }

    return err(400, 'Unknown op');
  } catch (e) {
    return err(500, 'Internal: ' + (e as Error).message);
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-pass', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
}
function ok(status: number, body = '', headers: Record<string,string> = {}) { return { statusCode: status, headers: { 'Content-Type': 'application/json', ...headers }, body }; }
function err(status: number, msg: string) { return ok(status, JSON.stringify({ error: msg }), cors()); }
