// netlify/functions/api.ts
import type { Handler } from '@netlify/functions';
import { Client } from 'pg';

// ← НОВОЕ: AWS SDK для S3 presign
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const WRITE_PASSWORD = process.env.WRITE_PASSWORD!;
const DATABASE_URL = process.env.DATABASE_URL!;

// S3 конфигурация
const S3_ENDPOINT = process.env.S3_ENDPOINT!;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY!;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY!;
const S3_BUCKET = process.env.S3_BUCKET!;
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const SUPABASE_PROJECT_URL = process.env.SUPABASE_PROJECT_URL!;

// S3 клиент с кастомным endpoint Supabase и path-style адресацией
const s3 = new S3Client({
  region: S3_REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  endpoint: S3_ENDPOINT,           // https://...supabase.co/storage/v1/s3
  forcePathStyle: true,            // Важно для совместимости
});

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
      if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET || !SUPABASE_PROJECT_URL) {
        return { statusCode: 500, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'S3 configuration missing' }) };
      }

      const body = event.body ? JSON.parse(event.body) : {};
      const board: BoardKey = body.board === 'styleboard' ? 'styleboard' : 'moodboard';
      const id: string = body.id || cryptoRandom();
      const mime: string = typeof body.mime === 'string' && body.mime ? body.mime : 'application/octet-stream';
      const ext = mime.startsWith('image/') ? mime.split('/')[1] : 'bin';
      const objectKey = `${board}/${id}.${ext}`;

      // Подписываем однократный PUT на 5 минут
      const cmd = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        ContentType: mime,
        // ВАЖНО: без ACL — Supabase Storage управляет публичностью на уровне bucket'а
      });
      const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 });

      // Публичный URL (для чтения) через Supabase public endpoint:
      const publicUrl = `${SUPABASE_PROJECT_URL}/storage/v1/object/public/${S3_BUCKET}/${objectKey}`;

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

      const db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await db.connect();
      const q = await db.query(
        `SELECT id, board, url, kind, gx, gy, gw, gh, approved, natw AS "natW", nath AS "natH", natr AS "natR"
         FROM sb_items
         WHERE board = $1
         ORDER BY id`,
        [board]
      );
      await db.end();
      return ok(200, JSON.stringify({ items: q.rows }), cors());
    }

    if (op === 'clear') {
      const pass = event.headers['x-pass'] || (event.body && JSON.parse(event.body||'{}').pass);
      if (pass !== WRITE_PASSWORD) return err(401, 'Unauthorized');

      const board = url.searchParams.get('board'); // можно указать конкретный
      const db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await db.connect();
      if (board) {
        await db.query(`DELETE FROM sb_items WHERE board = $1`, [board]);
      } else {
        await db.query(`TRUNCATE sb_items`);
      }
      await db.end();
      return ok(200, JSON.stringify({ ok: true }), cors());
    }

    if (op === 'save') {
      const pass = event.headers['x-pass'] || (event.body && JSON.parse(event.body||'{}').pass);
      if (pass !== WRITE_PASSWORD) return err(401, 'Unauthorized');

      const { board, items } = JSON.parse(event.body || '{}');
      if (!board) return err(400, 'board is required');
      if (!Array.isArray(items)) return err(400, 'items must be an array');

      const db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await db.connect();
      try {
        await db.query('BEGIN');
        await db.query(`DELETE FROM sb_items WHERE board = $1`, [board]);

        // Вставляем, ПОДСТАВЛЯЯ board из body:
        for (const it of items) {
          await db.query(
            `INSERT INTO sb_items
               (id, board, url, kind, gx, gy, gw, gh, approved, natw, nath, natr)
             VALUES
               ($1, $2, $3,  $4,  $5, $6, $7, $8, COALESCE($9,false), $10, $11, $12)`,
            [
              it.id,
              board,               // ← НЕ it.board!
              it.url,
              it.kind,
              it.gx, it.gy, it.gw, it.gh,
              it.approved ?? false,
              it.natW ?? null, it.natH ?? null, it.natR ?? null,
            ]
          );
        }

        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        await db.end();
        return err(500, 'db error: ' + (e as Error).message);
      }
      await db.end();
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
