// netlify/functions/api.ts
import type { Handler } from '@netlify/functions';
import { Pool } from 'pg';

// ← НОВОЕ: AWS SDK для S3 presign
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-pass',
};

type BoardKey = 'moodboard' | 'styleboard';
type Kind = 'image' | 'video' | 'site';
type SBItem = {
  id: string; board: BoardKey; url: string; kind: Kind;
  gx: number; gy: number; gw: number; gh: number;
  approved?: boolean; natw?: number|null; nath?: number|null; natr?: number|null;
};

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

async function ensureSchema() {
  await pool.query(`
    create table if not exists sb_items (
      id text primary key,
      board text not null check (board in ('moodboard','styleboard')),
      url text not null,
      kind text not null check (kind in ('image','video','site')),
      gx double precision not null,
      gy double precision not null,
      gw double precision not null,
      gh double precision not null,
      approved boolean not null default false,
      natw int, nath int, natr double precision,
      created_at timestamptz not null default now()
    );
    create index if not exists sb_items_board_idx on sb_items(board);
  `);
}

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
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS, body: '' };
    }

    const qs = event.queryStringParameters || {};
    const op = (qs.op || (event.httpMethod === 'POST' ? 'save' : 'list')) as 'list'|'save'|'sign-upload';

    // ─────────────────────────────────────────────────────────────
    // 1) ПОДПИСЬ ЗАГРУЗКИ В S3 (Supabase Storage S3-совместимый)
    // ─────────────────────────────────────────────────────────────
    if (op === 'sign-upload' && event.httpMethod === 'POST') {
      const pass = pickHeader(event.headers as any, 'x-pass') || '';
      if (!process.env.WRITE_PASSWORD || pass !== process.env.WRITE_PASSWORD) {
        return { statusCode: 401, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized' }) };
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
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedUrl, publicUrl, id, objectKey })
      };
    }

    // ─────────────────────────────────────────────────────────────
    // 2) CRUD в БД (как и раньше)
    // ─────────────────────────────────────────────────────────────
    await ensureSchema();

    let boardFromQS = (qs.board || (event.body ? JSON.parse(event.body).board : '')) as string;
    const board: BoardKey = boardFromQS === 'styleboard' ? 'styleboard' : 'moodboard';

    if (op === 'list' && event.httpMethod === 'GET') {
      const { rows } = await pool.query(`select * from sb_items where board=$1 order by created_at asc`, [board]);
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: rows }) };
    }

    if (op === 'save' && event.httpMethod === 'POST') {
      const body = event.body ? JSON.parse(event.body) : {};
      const pass = pickHeader(event.headers as any, 'x-pass') || body.pass || '';
      if (!process.env.WRITE_PASSWORD || pass !== process.env.WRITE_PASSWORD) {
        return { statusCode: 401, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized' }) };
      }

      const items: SBItem[] = Array.isArray(body.items) ? body.items : [];
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from sb_items where board=$1', [board]);
        for (const it of items) {
          await client.query(
            `insert into sb_items (id,board,url,kind,gx,gy,gw,gh,approved,natw,nath,natr)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             on conflict (id) do update set
               board=excluded.board,url=excluded.url,kind=excluded.kind,
               gx=excluded.gx,gy=excluded.gy,gw=excluded.gw,gh=excluded.gh,
               approved=excluded.approved,natw=excluded.natw,nath=excluded.nath,natr=excluded.natr`,
            [it.id, it.board, it.url, it.kind, it.gx, it.gy, it.gw, it.gh, !!it.approved, it.natw ?? null, it.nath ?? null, it.natr ?? null]
          );
        }
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        console.error('[api] save error', e);
        return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'db', detail: String(e) }) };
      } finally {
        client.release();
      }
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  } catch (e: any) {
    console.error('[api] fatal', e);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'fatal', detail: String(e?.message || e) }) };
  }
};
