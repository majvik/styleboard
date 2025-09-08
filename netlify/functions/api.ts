// netlify/functions/api.ts
import type { Handler } from '@netlify/functions';
import { Client } from 'pg';

const WRITE_PASSWORD = process.env.WRITE_PASSWORD!;
const DATABASE_URL = process.env.DATABASE_URL!;

export const handler: Handler = async (event) => {
  const url = new URL(event.rawUrl);
  const op = url.searchParams.get('op') || 'list';

  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return ok(200, '', { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-pass', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  }

  try {
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
