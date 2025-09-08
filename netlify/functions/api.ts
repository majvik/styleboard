// netlify/functions/api.ts
import type { Handler } from '@netlify/functions';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // pooled + sslmode=require
  max: 5,
  idleTimeoutMillis: 30_000,
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-pass',
};

type SBItem = {
  id: string; board: 'moodboard'|'styleboard'; url: string; kind: 'image'|'video'|'site';
  gx: number; gy: number; gw: number; gh: number; approved: boolean;
  natw?: number|null; nath?: number|null; natr?: number|null;
};

async function ensureSchema() {
  await pool.query(`
    create table if not exists sb_items (
      id text primary key,
      board text not null,
      url text not null,
      kind text not null,
      gx int not null, gy int not null, gw int not null, gh int not null,
      approved boolean not null default false,
      natw int, nath int, natr double precision,
      created_at timestamptz not null default now()
    );
    create index if not exists sb_items_board_idx on sb_items(board);
  `);
}

export const handler: Handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS, body: '' };
    }

    const op = (event.queryStringParameters?.op || 'list') as 'list'|'save';
    const board = (event.queryStringParameters?.board ||
                   (event.httpMethod === 'POST' ? (JSON.parse(event.body||'{}').board) : '')) as 'moodboard'|'styleboard';

    if (!board || (board !== 'moodboard' && board !== 'styleboard')) {
      return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'bad board' }) };
    }

    await ensureSchema();

    if (op === 'list' && event.httpMethod === 'GET') {
      const { rows } = await pool.query<SBItem>(`select * from sb_items where board=$1 order by created_at asc`, [board]);
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: rows }) };
    }

    if (op === 'save' && event.httpMethod === 'POST') {
      // простая «аутентификация» по паролю
      const pass = event.headers['x-pass'] || event.headers['X-Pass'] || event.headers['x-Pass'];
      if (!process.env.WRITE_PASSWORD || pass !== process.env.WRITE_PASSWORD) {
        return { statusCode: 401, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized' }) };
      }

      const payload = JSON.parse(event.body || '{}');
      const items: SBItem[] = Array.isArray(payload.items) ? payload.items : [];

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
            [it.id, board, it.url, it.kind, it.gx, it.gy, it.gw, it.gh, !!it.approved, it.natw ?? null, it.nath ?? null, it.natr ?? null]
          );
        }
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }

      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  } catch (e: any) {
    console.error('[api] save error', e);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'db', detail: String(e) })
    };
  }
};
