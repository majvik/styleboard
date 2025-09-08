import React, { useEffect, useRef, useState, useLayoutEffect } from "react";
import { remoteLoad, remoteSave, blobToDataURL } from './remote';
// inline CSS для прогресс-бара
const SBProgressCSS = (
  <style>{`
    @keyframes sb-run { 
      0% { background-position: 0 0; }
      100% { background-position: 200% 0; }
    }
    .sb-progress{
      background-image: repeating-linear-gradient(
        45deg,
        rgba(16,185,129,.35) 0px,
        rgba(16,185,129,.35) 10px,
        rgba(16,185,129,.6) 10px,
        rgba(16,185,129,.6) 20px
      );
      background-size: 200% 100%;
      animation: sb-run 1s linear infinite;
    }
  `}</style>
);

/**
 * Website Styleboard — Local (React + TS + Tailwind)
 * - Two boards (Moodboard / Styleboard)
 * - URL input + add +
 * - Zoom +/- (buttons + kbd), Ctrl/Cmd + wheel (cursor-centered)
 * - Space + drag panning (Miro-like)
 * - 16px grid, ordered auto-placement (not random)
 * - Items: image, video, site(iframe exact 1440x1080)
 * - Per-item HUD: copy, Approve (prominent), Delete
 * - Preloader
 * - localStorage per board
 */

const BOARD_KEYS = ["moodboard", "styleboard"] as const;
type BoardKey = typeof BOARD_KEYS[number];
type ItemKind = "image" | "video" | "site";

// NEW: натуральные размеры для точного аспекта (используются в moodboard)
interface SBItem {
  id: string;
  url: string;
  kind: ItemKind;
  gx: number;
  gy: number;
  gw: number;
  gh: number;
  approved: boolean;
  natW?: number;       // пиксельная ширина исходного изображения
  natH?: number;       // пиксельная высота исходного изображения
  natR?: number;       // нат. аспект = natW / natH (кэш)
}

const GRID = 16;
const GUTTER = 1; // 1 клетка (16px) вокруг каждого материала
const DEBUG = true;
const TILE_W = 45;        // 720px
const TILE_H = 30;        // 480px
const TILE_IFRAME_W = 90; // 1440/16
const TILE_IFRAME_H = 68; // ~1088/16 ~ 68 (render exact 1080px)

const CANVAS_W = 12000;
const CANVAS_H = 12000;
const WORLD_COLS = Math.floor(CANVAS_W / GRID);
const WORLD_ROWS = Math.floor(CANVAS_H / GRID);

// ——— Moodboard config ———
const HD = { BASE_W: 1920, BASE_H: 1080, MIN_SIDE: 480, MAX_SIDE: 1920 };
const MOOD_ASPECTS = [1, 4/3, 3/4, 16/9, 9/16, 3/2, 2/3];

// ——— Moodboard aspect bounds ———
const R_MIN = 9 / 16;  // 0.5625   (не уже чем 9:16)
const R_MAX = 16 / 9;  // 1.7777…  (не шире чем 16:9)

// NEW: расширенный набор аспектов и утилиты для пачек/шахматности
const MOOD_ASPECTS_EXT = [
  1, 4/3, 3/4, 16/9, 9/16, 3/2, 2/3, 5/4, 4/5, 7/5, 5/7
].map(r => clamp(r, R_MIN, R_MAX));

// слегка «вкуснее» распределение размеров строк: короткая/высокая
function pickRowHeight(baseMin:number, baseMax:number, rowIndex:number){
  // чётные строки — «короче», нечётные — «выше», чтобы получалась «стяжка» как в Picasa
  const shortMin = Math.max(baseMin, Math.floor((baseMin*1.0)));
  const shortMax = Math.max(shortMin, Math.floor((baseMax*0.78)));
  const tallMin  = Math.max(baseMin, Math.floor((baseMin*1.1)));
  const tallMax  = Math.min(baseMax, Math.floor((baseMax*1.15)));
  const [lo, hi] = (rowIndex % 2 === 0) ? [shortMin, shortMax] : [tallMin, tallMax];
  return randInt(lo, hi);
}

// NEW: «фаза» ослабления аспектов, чтобы гарантированно заполнить строку/артборд
const RATIO_EPS_BASE = 0.00;   // старт: строго натуральные аспекты
const RATIO_EPS_STEP = 0.03;   // шаг расширения допусков (±3%)
const RATIO_EPS_MAX  = 0.10;   // максимум ±10% от натурального аспекта

// Небольшое «прилипание» к колонкам между соседними строками (чем больше — тем сильней)
const COLUMN_BIAS = 0.35;      // 0..1 (0 — нет, 1 — максимум) — низкий приоритет, как просили

// 480..1920 → в клетках 16px
const MIN_SIDE_CELLS = Math.floor(HD.MIN_SIDE / GRID); // 30
const MAX_SIDE_CELLS_MOOD = Math.floor(HD.MAX_SIDE / GRID); // 120

function snapToEvenHDMultiple(wPx:number, hPx:number){
  // k — кратность 1920×1080; чтобы высота кратно 16, берем только чётные k (1080/16=67.5)
  const kW = Math.max(1, Math.round(wPx / HD.BASE_W));
  const kH = Math.max(1, Math.round(hPx / HD.BASE_H));
  let k = Math.max(kW, kH);
  if (k % 2 !== 0) k += 1; // только чётные
  return { w: HD.BASE_W * k, h: HD.BASE_H * k };
}

const CANVAS_LIMITS = { MIN: 1000, MAX: 20000 };

function snap16(n:number){ return Math.max(16, Math.round(n/16)*16); }

function sanitizeStyleField(vStr:string){
  const v = parseInt(vStr.replace(/[^\d]/g,''),10) || 0;
  return snap16(v);
}

function sanitizeMoodFromWidth(wStr:string){
  const wRaw = parseInt(wStr.replace(/[^\d]/g,''),10) || 0;
  let k = Math.max(1, Math.round(wRaw / HD.BASE_W));
  if (k % 2 !== 0) k += 1;
  return { w: snap16(HD.BASE_W * k), h: snap16(HD.BASE_H * k) };
}
function sanitizeMoodFromHeight(hStr:string){
  const hRaw = parseInt(hStr.replace(/[^\d]/g,''),10) || 0;
  let k = Math.max(1, Math.round(hRaw / HD.BASE_H));
  if (k % 2 !== 0) k += 1;
  return { w: snap16(HD.BASE_W * k), h: snap16(HD.BASE_H * k) };
}

function randInt(min:number, max:number){ return Math.floor(Math.random()*(max-min+1))+min; }
function randChoice<T>(arr:T[]){ return arr[Math.floor(Math.random()*arr.length)]; }
function shuffleInPlace<T>(a:T[]){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

// NEW: извлечение натуральных размеров из Blob (используйте при добавлении изображений)
async function readImageBlobSize(blob: Blob): Promise<{w:number; h:number}> {
  try {
    // createImageBitmap быстрее и без CORS-плясок
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    bmp.close?.();
    if (w > 0 && h > 0) return { w, h };
  } catch {}
  // Fallback через <img>
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { 
      const w = img.naturalWidth, h = img.naturalHeight;
      URL.revokeObjectURL(url);
      if (w>0 && h>0) resolve({w,h}); else reject(new Error('bad image'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load error')); };
    img.src = url;
  });
}

// NEW: применяем к только что созданному элементу (не блокирует UI)
function assignNatSizeToItem(item: SBItem, blob: Blob, onReady?: ()=>void) {
  readImageBlobSize(blob).then(({w,h})=>{
    item.natW = w; item.natH = h; item.natR = (w > 0 && h > 0) ? (w/h) : undefined;
    onReady?.();
    // Ре-лейаут будет вызван из компонента при необходимости
  }).catch(()=>{ /* тихо игнорируем */ });
}

// --- sizes & grid ---
const MAX_SIDE = 1440;           // px
const MAX_SIDE_CELLS = Math.floor(MAX_SIDE / GRID); // 90

function nearestGrid(px: number) {
  return Math.max(1, Math.round(px / GRID));
}
function capToMaxSide(w:number, h:number, maxSide=MAX_SIDE) {
  const m = Math.max(w, h);
  if (m <= maxSide) return { w, h };
  const s = maxSide / m;
  return { w: Math.round(w*s), h: Math.round(h*s) };
}

// --- helpers to keep aspect in cells (<= 1440 px, snap to 16px) ---
function cellsFromPxNoCrop(pxW:number, pxH:number) {
  const { w, h } = capToMaxSide(pxW, pxH); // сохраняет пропорции, режет только длинную сторону до 1440px
  const gw = Math.min(MAX_SIDE_CELLS, Math.ceil(w / GRID));
  const gh = Math.min(MAX_SIDE_CELLS, Math.ceil(h / GRID));
  return { gw, gh };
}

// --- media probing ---
const FALLBACK_IMG = { w: 720, h: 480 };
const FALLBACK_VID = { w: 720, h: 480 };

function probeImage(url: string): Promise<{w:number;h:number}> {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth || FALLBACK_IMG.w, h: im.naturalHeight || FALLBACK_IMG.h });
    im.onerror = () => res(FALLBACK_IMG);
    im.src = url;
  });
}
function probeVideo(url: string): Promise<{w:number;h:number}> {
  return new Promise(res => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { res({ w: v.videoWidth || FALLBACK_VID.w, h: v.videoHeight || FALLBACK_VID.h }); v.remove(); };
    v.onerror = () => { res(FALLBACK_VID); v.remove(); };
    v.src = url;
  });
}

// Минимальные логи
const LOG = {
  placement: true,     // одна строка на добавление
  itemsTable: false,   // сводная таблица всех айтемов
  tileRender: false,   // логи внутри Tile (по умолчанию выкл)
  conflicts: false,    // логи конфликтов в canPlace
} as const;

function uid() { return Math.random().toString(36).slice(2, 9); }

function detectKind(url: string): ItemKind {
  const u = url.split('?')[0].toLowerCase();
  if (u.startsWith('data:image/')) return 'image';
  if (u.startsWith('data:video/')) return 'video';
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(u)) return "image";
  if (/\.(mp4|webm|ogg)$/.test(u)) return "video";
  return "site";
}

// idb:// helpers
const IDB_URL_PREFIX = 'idb://';
const isIdbUrl = (u: string) => u.startsWith(IDB_URL_PREFIX);
const idFromIdbUrl = (u: string) => u.slice(IDB_URL_PREFIX.length);
async function maybeDeleteIdb(url: string) {
  if (isIdbUrl(url)) {
    try { await idbDeleteBlob(idFromIdbUrl(url)); } catch {}
  }
}

// permissions + validation
async function ensureClipboardReadPermission(): Promise<void> {
  try {
    // @ts-ignore
    if (navigator.permissions?.query) {
      // @ts-ignore
      const st = await navigator.permissions.query({ name: 'clipboard-read' });
      if (st.state === 'denied') throw new Error('denied');
    }
  } catch {}
}


// строгая проверка доступности URL
function validateImageUrl(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const im = new Image();
    im.onload = () => resolve(true);
    im.onerror = () => resolve(false);
    im.src = url;
  });
}
function validateVideoUrl(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { v.remove(); resolve(true); };
    v.onerror = () => { v.remove(); resolve(false); };
    v.src = url;
  });
}
async function validateUrl(u: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(u) && !u.startsWith('data:')) return false;
  const kind = detectKind(u);
  if (kind === 'image') return validateImageUrl(u);
  if (kind === 'video') return validateVideoUrl(u);
  return true; // сайт: проверим формат, доступность до загрузки не проверяем
}

function round2(n:number){ return Math.round(n*100)/100 }

function loadBoard(key: BoardKey): SBItem[] {
  try {
    const raw = localStorage.getItem(`styleboard:${key}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveBoard(key: BoardKey, items: SBItem[]) {
  try { localStorage.setItem(`styleboard:${key}`, JSON.stringify(items)); } catch {}
}


function canPlaceRect(gx:number, gy:number, gw:number, gh:number, items:SBItem[], W:number, H:number) {
  // границы полотна
  if (gx < 0 || gy < 0) return false;
  if (gx + gw > W || gy + gh > H) return false;

  // прямоугольные пересечения с учётом GUTTER
  const me = {
    x1: gx - GUTTER, y1: gy - GUTTER,
    x2: gx + gw + GUTTER - 1, y2: gy + gh + GUTTER - 1
  };
  for (const it of items) {
    const o = {
      x1: it.gx - GUTTER, y1: it.gy - GUTTER,
      x2: it.gx + it.gw + GUTTER - 1, y2: it.gy + it.gh + GUTTER - 1
    };
    // пересечение?
    if (!(me.x2 < o.x1 || o.x2 < me.x1 || me.y2 < o.y1 || o.y2 < me.y1)) {
      return false;
    }
  }
  return true;
}

function canPlaceWithStdGutter(
  gx:number, gy:number, gw:number, gh:number,
  others: SBItem[], W:number, H:number
){
  const { ps } = buildOccPS(others, W, H); // соседи с «ореолом» GUTTER
  return canPlacePS(gx, gy, gw, gh, ps, W, H); // кандидат без расширения
}

function getBBoxTight(items: SBItem[]) {
  if (!items.length) return null as any;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const it of items) {
    const x1 = it.gx;
    const y1 = it.gy;
    const x2 = it.gx + it.gw - 1;
    const y2 = it.gy + it.gh - 1;
    if (x1<minX) minX=x1;
    if (y1<minY) minY=y1;
    if (x2>maxX) maxX=x2;
    if (y2>maxY) maxY=y2;
  }
  return { minX, minY, maxX, maxY };
}

function getBBox(items: SBItem[]) {
  if (!items.length) return null as null | {minX:number,minY:number,maxX:number,maxY:number};
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const it of items) {
    const x1 = it.gx - GUTTER;
    const y1 = it.gy - GUTTER;
    const x2 = it.gx + it.gw + GUTTER - 1;
    const y2 = it.gy + it.gh + GUTTER - 1;
    if (x1<minX) minX=x1;
    if (y1<minY) minY=y1;
    if (x2>maxX) maxX=x2;
    if (y2>maxY) maxY=y2;
  }
  return { minX, minY, maxX, maxY };
}

function spawnFor(gw:number, gh:number, W:number, H:number) {
  const cx = Math.floor(W / 2) - Math.floor(gw/2);
  const cy = Math.floor(H / 2) - Math.floor(gh/2);
  return { gx: cx, gy: cy };
}

// --- utils ---
function clamp(v:number, lo:number, hi:number){ return Math.max(lo, Math.min(hi, v)); }

// --- только для site ---
function getSiteItems(items: SBItem[]) { return items.filter(i => i.kind === 'site'); }

function getNextSiteRingSide(items: SBItem[]) {
  const n = getSiteItems(items).length;
  if (n === 0) return { ring: 0, side: -1 as -1 | 0 | 1 | 2 | 3 }; // первый — в центр
  const k = n - 1;
  return { ring: Math.floor(k / 4), side: (k % 4) as 0 | 1 | 2 | 3 }; // 0:R 1:D 2:L 3:U
}

// БАЗОВЫЕ координаты стороны: строго с зазором 1 клетка (2*GUTTER в сумме двух footprint'ов)
function sideOffsetCoords(
  origin: { gx:number; gy:number; gw:number; gh:number },
  gw:number, gh:number,
  ring:number, side:0|1|2|3
) {
  const XMIN=0, YMIN=0, XMAX=WORLD_COLS - gw, YMAX=WORLD_ROWS - gh;

  // шаг кольца от размера ПЕРВОГО site
  const stepX = origin.gw + 2*GUTTER;
  const stepY = origin.gh + 2*GUTTER;

  // важно: используем ±(2*GUTTER), а не "+GUTTER (+1)"
  const baseRightX = origin.gx + origin.gw + 2*GUTTER + ring * stepX;
  const baseDownY  = origin.gy + origin.gh + 2*GUTTER + ring * stepY;
  const baseLeftX  = origin.gx - gw - 2*GUTTER - ring * stepX;
  const baseUpY    = origin.gy - gh - 2*GUTTER - ring * stepY;

  let x=origin.gx, y=origin.gy;
  if (side===0) { x = baseRightX; y = origin.gy; }         // RIGHT
  else if (side===1) { y = baseDownY;  x = origin.gx; }    // DOWN
  else if (side===2) { x = baseLeftX;  y = origin.gy; }    // LEFT
  else {                y = baseUpY;    x = origin.gx; }    // UP

  return { gx: clamp(x, XMIN, XMAX), gy: clamp(y, YMIN, YMAX) };
}

// компактный центр-наружу по 1D (0, +1, −1, +2, −2) для МАЛЕНЬКОЙ компенсации
function* centerOut1D(anchor:number, lo:number, hi:number){
  let step = 0;
  while (true){
    const a = anchor + step;
    if (a >= lo && a <= hi) yield a;
    if (step !== 0) {
      const b = anchor - step;
      if (b >= lo && b <= hi) yield b;
    }
    step++;
    if (anchor - step < lo && anchor + step > hi) break;
  }
}

// === IndexedDB for media blobs ===
const IDB_NAME = 'styleboard';
const IDB_STORE = 'media';
// было: 1
const IDB_VERSION = 2; // ← чтобы не «даунгрейдить» существующую БД
type SBMediaRow = { id: string; blob: Blob; mime: string; createdAt: number };

// helper для полного удаления БД (используем при ?sb=clear)
function idbDrop(): Promise<void> {
  return new Promise((resolve) => {
    const del = indexedDB.deleteDatabase(IDB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => resolve(); // игнорируем сбой — нам важна идемпотентность
    del.onblocked = () => resolve();
  });
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);

    // NEW: аккуратно обрабатываем «даунгрейд» — открываем без указания версии
    req.onerror = () => {
      const err = req.error;
      if (err && (err as any).name === 'VersionError') {
        const req2 = indexedDB.open(IDB_NAME); // откроет текущую (старшую) версию БД
        req2.onsuccess = () => resolve(req2.result);
        req2.onerror = () => reject(req2.error);
        return;
      }
      reject(err);
    };
  });
}

async function idbPutBlob(blob: Blob): Promise<string> {
  const db = await idbOpen();
  const id = Math.random().toString(36).slice(2, 10);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(IDB_STORE);
    const row: SBMediaRow = { id, blob, mime: blob.type || 'application/octet-stream', createdAt: Date.now() };
    store.put(row);
  });
  db.close();
  return id;
}

async function idbGetBlob(id: string): Promise<Blob | null> {
  const db = await idbOpen();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ? (req.result as SBMediaRow).blob : null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

async function idbDeleteBlob(id: string): Promise<void> {
  const db = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_STORE).delete(id);
  });
  db.close();
}

// === fast occupancy: grid + prefix sums (O(1) проверка прямоугольника) ===

type OccPS = { grid: Uint8Array; ps: Uint32Array };

function buildOccPS(items: SBItem[], W:number, H:number): OccPS {
  const grid = new Uint8Array(W * H);

  for (const it of items) {
    const minX = Math.max(0, it.gx - GUTTER);
    const maxX = Math.min(W - 1, it.gx + it.gw + GUTTER - 1);
    const minY = Math.max(0, it.gy - GUTTER);
    const maxY = Math.min(H - 1, it.gy + it.gh + GUTTER - 1);
    for (let y = minY; y <= maxY; y++) {
      const rowStart = y * W + minX;
      const rowEnd   = y * W + maxX + 1;
      grid.fill(1, rowStart, rowEnd);
    }
  }

  // 2D prefix sums
  const ps = new Uint32Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y++) {
    let rowSum = 0;
    for (let x = 1; x <= W; x++) {
      rowSum += grid[(y - 1) * W + (x - 1)];
      ps[y * (W + 1) + x] = ps[(y - 1) * (W + 1) + x] + rowSum;
    }
  }
  return { grid, ps };
}

// === exact occupancy (без GUTTER) для moodboard-проверок ===
function buildOccPSExact(items: SBItem[], W:number, H:number) {
  const grid = new Uint8Array(W * H);
  // заполняем ровно занимаемые клетки (без ореолов)
  for (const it of items) {
    const minX = Math.max(0, it.gx);
    const maxX = Math.min(W - 1, it.gx + it.gw - 1);
    const minY = Math.max(0, it.gy);
    const maxY = Math.min(H - 1, it.gy + it.gh - 1);
    for (let y = minY; y <= maxY; y++) {
      const rowStart = y * W + minX;
      const rowEnd   = y * W + maxX + 1;
      // если попадём на уже занятую клетку — будет overlap
      for (let k=rowStart; k<rowEnd; k++) {
        if (grid[k]) return { grid, overlapped: true };
        grid[k] = 1;
      }
    }
  }
  return { grid, overlapped: false };
}

function hasOverlapExact(items: SBItem[], W:number, H:number): boolean {
  return buildOccPSExact(items, W, H).overlapped;
}

function rectHasOcc(ps: Uint32Array, x1: number, y1: number, x2: number, y2: number, W: number) {
  const S = W + 1;
  const A = ps[y1 * S + x1];
  const B = ps[y1 * S + (x2 + 1)];
  const C = ps[(y2 + 1) * S + x1];
  const D = ps[(y2 + 1) * S + (x2 + 1)];
  return (D - B - C + A) > 0;
}

function canPlacePS(gx:number, gy:number, gw:number, gh:number, ps: Uint32Array, W:number, H:number) {
  if (gx < 0 || gy < 0) return false;
  if (gx + gw > W || gy + gh > H) return false;
  return !rectHasOcc(ps, gx, gy, gx + gw - 1, gy + gh - 1, W);
}

// 2) Быстрая проверка "можно ли поставить сюда"
function canPlaceFast(gx:number, gy:number, gw:number, gh:number, occ:Set<string>) {
  // в пределах мира (без учета собственного GUTTER — он уже включен в occ соседей)
  if (gx < 0 || gy < 0) return false;
  if (gx + gw > WORLD_COLS || gy + gh > WORLD_ROWS) return false;

  // клетки прямоугольника кандидата
  for (let y = 0; y < gh; y++) {
    const yy = gy + y;
        for (let x = 0; x < gw; x++) {
      const xx = gx + x;
      if (occ.has(`${xx},${yy}`)) return false;
    }
  }
  return true;
}

// граница вокруг каждого айтема (кольцо шириной 1 клетка, с учётом GUTTER)
function buildFrontierFromItems(items: SBItem[], grid: Uint8Array, W:number, H:number) {
  const f = new Set<string>();
  for (const it of items) {
    const minX = Math.max(0, it.gx - GUTTER);
    const maxX = Math.min(W - 1, it.gx + it.gw + GUTTER - 1);
    const minY = Math.max(0, it.gy - GUTTER);
    const maxY = Math.min(H - 1, it.gy + it.gh + GUTTER - 1);

    const yTop = minY - 1, yBot = maxY + 1, xLeft = minX - 1, xRight = maxX + 1;

    if (yTop >= 0) for (let x = minX; x <= maxX; x++) if (grid[yTop * W + x] === 0) f.add(`${x},${yTop}`);
    if (yBot <  H) for (let x = minX; x <= maxX; x++) if (grid[yBot * W + x] === 0) f.add(`${x},${yBot}`);
    if (xLeft >= 0) for (let y = minY; y <= maxY; y++) if (grid[y * W + xLeft] === 0) f.add(`${xLeft},${y}`);
    if (xRight <  W) for (let y = minY; y <= maxY; y++) if (grid[y * W + xRight] === 0) f.add(`${xRight},${y}`);
  }
  return f;
}

// Быстрый подсчёт касания рёбер (нужен порог >=2, >=1)
function edgeTouchSum(gx:number, gy:number, gw:number, gh:number, grid: Uint8Array, W:number, H:number) {
  let s = 0;
  for (let x=gx; x<gx+gw; x++) {
    if (gy-1>=0 && grid[(gy-1)*W + x]) s++;         // top
    if (gy+gh<H && grid[(gy+gh)*W + x]) s++;        // bottom
  }
  for (let y=gy; y<gy+gh; y++) {
    if (gx-1>=0 && grid[y*W + (gx-1)]) s++;         // left
    if (gx+gw<W && grid[y*W + (gx+gw)]) s++;        // right
  }
  return s;
}

// подсчёт «прижима» по рёбрам (используем grid — быстро)
function edgeTouchScore(gx:number, gy:number, gw:number, gh:number, grid: Uint8Array, anchor: SBItem, W:number, H:number) {
  let top=0,bottom=0,left=0,right=0;

  for (let x = gx; x < gx + gw; x++) {
    if (gy - 1 >= 0 && grid[(gy - 1) * W + x]) top++;
    if (gy + gh <  H && grid[(gy + gh) * W + x]) bottom++;
  }
  for (let y = gy; y < gy + gh; y++) {
    if (gx - 1 >= 0 && grid[y * W + (gx - 1)]) left++;
    if (gx + gw <  W && grid[y * W + (gx + gw)]) right++;
  }

  const bySide = [right, bottom, left, top]; // R,D,L,U
  const sum = top + bottom + left + right;
  const cornerBonus =
    (bySide[0] && bySide[3]) || (bySide[0] && bySide[1]) ||
    (bySide[2] && bySide[3]) || (bySide[2] && bySide[1]) ? 1000 : 0;

  const ax = anchor.gx + anchor.gw/2, ay = anchor.gy + anchor.gh/2;
  const cx = gx + gw/2,               cy = gy + gh/2;
  const dist = Math.abs(cx - ax) + Math.abs(cy - ay);
  const sideIdx = sideIndexRDLU(anchor, gx, gy, gw, gh); // твоя функция

  return sum * 100000 + cornerBonus - dist * 10 - sideIdx;
}

// сколько я «касаюсь» существующих по рёбрам (учитываем R,D,L,U в таком порядке)
function edgeTouchCount(gx:number, gy:number, gw:number, gh:number, occ:Set<string>) {
  let top=0,bottom=0,left=0,right=0;
  for (let x=gx; x<gx+gw; x++) {
    if (occ.has(`${x},${gy-1}`)) top++;
    if (occ.has(`${x},${gy+gh}`)) bottom++;
  }
  for (let y=gy; y<gy+gh; y++) {
    if (occ.has(`${gx-1},${y}`)) left++;
    if (occ.has(`${gx+gw},${y}`)) right++;
  }
  const bySide = [right, bottom, left, top]; // R, D, L, U
  const sum = top + bottom + left + right;
  return { sum, bySide };
}

// куда лежит кандидат относительно якоря — для R→D→L→U tie-break'а
function sideIndexRDLU(anchor: SBItem, gx:number, gy:number, gw:number, gh:number) {
  const ax = anchor.gx + anchor.gw/2, ay = anchor.gy + anchor.gh/2;
  const cx = gx + gw/2,            cy = gy + gh/2;
  const dx = cx - ax,               dy = cy - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2; // R/L
  return dy >= 0 ? 1 : 3; // D/U
}

// 3) Жёсткая R → D → L → U раскладка для site, с углами и ограничением количества колец
function findPlacementSiteRDLUStrict(items: SBItem[], gw: number, gh: number, W:number, H:number) {
  // первый site — в центр
  const anchor = items.find(i => i.kind === 'site') ?? null;
  if (!anchor) return spawnFor(gw, gh, W, H);

  const { ps } = buildOccPS(items, W, H);

  const XMAX = W - gw;
  const YMAX = H - gh;

  // шаг кольца — от РАЗМЕРА site-тайла (фикс: 90x68) + двойной GUTTER
  const stepX = anchor.gw + 2 * GUTTER;
  const stepY = anchor.gh + 2 * GUTTER;

  // максимальный номер кольца, который ещё может попадать в границы мира
  const rRightMax = Math.floor((XMAX - (anchor.gx + anchor.gw + 2*GUTTER)) / stepX);
  const rLeftMax  = Math.floor((anchor.gx - gw - 2*GUTTER) / stepX);
  const rDownMax  = Math.floor((YMAX - (anchor.gy + anchor.gh + 2*GUTTER)) / stepY);
  const rUpMax    = Math.floor((anchor.gy - gh - 2*GUTTER) / stepY);
  const RMAX = Math.max(rRightMax, rLeftMax, rDownMax, rUpMax);

  if (RMAX < 0) return null; // совсем некуда

  // перечисляем координаты в строгом порядке R → D → L → U,
  // на каждой стороне — топ-даун/лево-направо, + добавляем 4 угла
  for (let r = 0; r <= RMAX; r++) {
    const xR = anchor.gx + anchor.gw + 2*GUTTER + r*stepX;
    const yD = anchor.gy + anchor.gh + 2*GUTTER + r*stepY;
    const xL = anchor.gx - gw - 2*GUTTER - r*stepX;
    const yU = anchor.gy - gh - 2*GUTTER - r*stepY;

    // RIGHT: фикс x, y: top -> bottom
    if (xR >= 0 && xR <= XMAX) {
      for (let k = -r; k <= r; k++) {
        const y = anchor.gy + k*stepY;
        if (y < 0 || y > YMAX) continue;
        if (canPlacePS(xR, y, gw, gh, ps, W, H)) return { gx: xR, gy: y };
      }
      // угол TR (вне полосы [-r..r], закрывает "дырку")
      if (yU >= 0 && yU <= YMAX && canPlacePS(xR, yU, gw, gh, ps, W, H)) return { gx: xR, gy: yU };
    }

    // DOWN: фикс y, x: left -> right
    if (yD >= 0 && yD <= YMAX) {
      for (let k = -r; k <= r; k++) {
        const x = anchor.gx + k*stepX;
        if (x < 0 || x > XMAX) continue;
        if (canPlacePS(x, yD, gw, gh, ps, W, H)) return { gx: x, gy: yD };
      }
      // угол BR
      if (xR >= 0 && xR <= XMAX && canPlacePS(xR, yD, gw, gh, ps, W, H)) return { gx: xR, gy: yD };
    }

    // LEFT: фикс x, y: top -> bottom
    if (xL >= 0 && xL <= XMAX) {
      for (let k = -r; k <= r; k++) {
        const y = anchor.gy + k*stepY;
        if (y < 0 || y > YMAX) continue;
        if (canPlacePS(xL, y, gw, gh, ps, W, H)) return { gx: xL, gy: y };
      }
      // угол BL
      if (yD >= 0 && yD <= YMAX && canPlacePS(xL, yD, gw, gh, ps, W, H)) return { gx: xL, gy: yD };
    }

    // UP: фикс y, x: left -> right
    if (yU >= 0 && yU <= YMAX) {
      for (let k = -r; k <= r; k++) {
        const x = anchor.gx + k*stepX;
        if (x < 0 || x > XMAX) continue;
        if (canPlacePS(x, yU, gw, gh, ps, W, H)) return { gx: x, gy: yU };
      }
      // угол TL
      if (xL >= 0 && xL <= XMAX && canPlacePS(xL, yU, gw, gh, ps, W, H)) return { gx: xL, gy: yU };
    }
  }

  // нет места на всём холсте
  return null;
}

// Змейка: центр-наружу по X (колонки), в колонке — центр-наружу по Y
function findPlacementSnakePacked(items: SBItem[], gw: number, gh: number, W:number, H:number) {
  if (!items.length) return spawnFor(gw, gh, W, H);

  const { grid, ps } = buildOccPS(items, W, H);
  const anchor = items[items.length - 1];

  // рабочая рамка вокруг текущего bbox (+ небольшой отступ)
  const bb = getBBox(items)!;
  const MARGIN = 2;
  const XMIN = clamp((bb.minX ?? 0) - gw - MARGIN, 0, W - gw);
  const XMAX = clamp((bb.maxX ?? 0) + MARGIN,      0, W - gw);
  const YMIN = clamp((bb.minY ?? 0) - gh - MARGIN, 0, H - gh);
  const YMAX = clamp((bb.maxY ?? 0) + MARGIN,      0, H - gh);

  // 3 прохода: сначала ищем «карманы» (>=2 рёбер касания), затем >=1, затем любое валидное место
  const thresholds = [2, 1, 0] as const;

  for (const minTouch of thresholds) {
    // центр-наружу по X
    for (const x of centerOut1D(anchor.gx, XMIN, XMAX)) {
      // центр-наружу по Y в текущей колонке
      for (const y of centerOut1D(anchor.gy, YMIN, YMAX)) {
        if (!canPlacePS(x, y, gw, gh, ps, W, H)) continue;
        if (minTouch === 0) return { gx: x, gy: y };

        const touch = edgeTouchSum(x, y, gw, gh, grid, W, H);
        if (touch >= minTouch) return { gx: x, gy: y };
      }
    }
  }

  // если в рамке ничего не нашлось — дешёвые запасные варианты
  return findPlacementRDLUDense(items, gw, gh, W, H) || findPlacementGeneric(items, gw, gh, W, H);
}

function findPlacementPacked(items: SBItem[], gw: number, gh: number, W:number, H:number) {
  if (!items.length) return spawnFor(gw, gh, W, H);

  const { grid, ps } = buildOccPS(items, W, H);
  const frontier = buildFrontierFromItems(items, grid, W, H);
  const anchor = items[items.length - 1];

  const candidates = new Set<string>();

  // генерим узкий набор top-left, «прижатых» к занятым
  for (const key of frontier) {
    const [fx, fy] = key.split(',').map(Number);

    const leftOcc  = (fx - 1 >= 0) && grid[fy * W + (fx - 1)] === 1;
    const rightOcc = (fx + 1 <  W) && grid[fy * W + (fx + 1)] === 1;
    const upOcc    = (fy - 1 >= 0) && grid[(fy - 1) * W + fx] === 1;
    const downOcc  = (fy + 1 <  H) && grid[(fy + 1) * W + fx] === 1;

    // прижать справа от соседнего блока
    if (leftOcc)  for (let t = 0; t < gh; t++) candidates.add(`${fx},${fy - t}`);
    // прижать слева от соседнего блока
    if (rightOcc) for (let t = 0; t < gh; t++) candidates.add(`${fx - gw + 1},${fy - t}`);
    // прижать снизу от соседнего блока
    if (upOcc)    for (let t = 0; t < gw; t++) candidates.add(`${fx - t},${fy}`);
    // прижать сверху от соседнего блока
    if (downOcc)  for (let t = 0; t < gw; t++) candidates.add(`${fx - t},${fy - gh + 1}`);
  }

  let best: { gx:number; gy:number; score:number } | null = null;

  for (const c of candidates) {
    const [gx, gy] = c.split(',').map(Number);
    if (!canPlacePS(gx, gy, gw, gh, ps, W, H)) continue; // O(1) проверка
    const score = edgeTouchScore(gx, gy, gw, gh, grid, anchor, W, H);
    if (!best || score > best.score) best = { gx, gy, score };
  }

  if (best) return { gx: best.gx, gy: best.gy };

  // запасные варианты (дешёвые)
  return findPlacementRDLUDense(items, gw, gh, W, H) || findPlacementGeneric(items, gw, gh, W, H);
}

function findPlacementRDLUDense(items: SBItem[], gw: number, gh: number, W:number, H:number) {
  if (!items.length) return spawnFor(gw, gh, W, H);

  const { ps } = buildOccPS(items, W, H); // включает GUTTER вокруг ВСЕХ существующих
  const XMAX = W - gw;
  const YMAX = H - gh;

  // якорь — последний добавленный (чтобы «прилипать» к уже растущему кластеру)
  const anchor = items[items.length - 1];

  // базовые «вплотную» координаты: +GUTTER (а не 2*GUTTER!)
  const baseR = anchor.gx + anchor.gw + GUTTER;
  const baseL = anchor.gx - gw - GUTTER;
  const baseD = anchor.gy + anchor.gh + GUTTER;
  const baseU = anchor.gy - gh - GUTTER;

  const tryFast = (x:number,y:number)=> (
    x>=0 && y>=0 && x<=XMAX && y<=YMAX && canPlacePS(x,y,gw,gh,ps,W,H)
  );

  // макс радиус по границам мира
  const rMaxR = Math.max(0, XMAX - baseR);
  const rMaxL = Math.max(0, baseL);
  const rMaxD = Math.max(0, YMAX - baseD);
  const rMaxU = Math.max(0, baseU);
  const RMAX = Math.max(rMaxR, rMaxL, rMaxD, rMaxU);

  for (let r = 0; r <= RMAX; r++) {
    // RIGHT: x фиксируем, y сверху вниз около anchor.gy
    {
      const x = baseR + r;
      if (x >= 0 && x <= XMAX) {
        for (let y = anchor.gy - r; y <= anchor.gy + r; y++) {
          if (tryFast(x, y)) return { gx: x, gy: y };
        }
      }
    }
    // DOWN: y фиксируем, x слева направо около anchor.gx
    {
      const y = baseD + r;
      if (y >= 0 && y <= YMAX) {
        for (let x = anchor.gx - r; x <= anchor.gx + r; x++) {
          if (tryFast(x, y)) return { gx: x, gy: y };
        }
      }
    }
    // LEFT
    {
      const x = baseL - r;
      if (x >= 0 && x <= XMAX) {
        for (let y = anchor.gy - r; y <= anchor.gy + r; y++) {
          if (tryFast(x, y)) return { gx: x, gy: y };
        }
      }
    }
    // UP
    {
      const y = baseU - r;
      if (y >= 0 && y <= YMAX) {
        for (let x = anchor.gx - r; x <= anchor.gx + r; x++) {
          if (tryFast(x, y)) return { gx: x, gy: y };
        }
      }
    }
  }
  return null; // нет места
}

// Общий fallback для image/video — спираль от центра под конкретный размер
function findPlacementGeneric(items: SBItem[], gw: number, gh: number, W:number, H:number) {
  const o = spawnFor(gw, gh, W, H);
  const ok = (x:number,y:number)=> canPlaceRect(x,y,gw,gh,items,W,H);
  return spiralFrom(o.gx, o.gy, ok, 30000);
}

// Спираль от точки (sx, sy) по часовой с шагом 1 клетка
function spiralFrom(
  sx:number, sy:number,
  ok:(x:number,y:number)=>boolean,
  maxRun=6000
): {gx:number;gy:number}|null {
  let x = sx, y = sy;
  if (ok(x,y)) return { gx:x, gy:y };
  let run = 1;
  const walk = (dx:number,dy:number,steps:number) => {
    for (let i=0;i<steps;i++){
      x += dx; y += dy;
      if (ok(x,y)) return true;
    }
    return false;
  };
  while (run<maxRun){
    if (walk(1,0,run)) return {gx:x,gy:y};   // R
    if (walk(0,1,run)) return {gx:x,gy:y};   // D
    run++;
    if (walk(-1,0,run)) return {gx:x,gy:y};  // L
    if (walk(0,-1,run)) return {gx:x,gy:y};  // U
    run++;
  }
  return null;
}

function* zigzag(start:number, step:number, min:number, max:number) {
  const seen = new Set<number>();
  let k = 0;
  const clamp = (v:number)=> Math.max(min, Math.min(max, v));
  while (true) {
    const off = (k===0) ? 0 : Math.ceil(k/2) * (k%2===0 ? -step : step);
    const v = clamp(start + off);
    if (!seen.has(v)) {
      seen.add(v);
      yield v;
    }
    if (seen.size >= Math.floor((max-min)/step) + 1) break;
    k++;
  }
}

// возвращает [lo, hi], выровненные к классу (start mod step)
function alignedBounds(start:number, step:number, min:number, max:number){
  const lo = start + Math.ceil((min - start)/step)*step;
  const hi = start + Math.floor((max - start)/step)*step;
  return [lo, hi];
}

// центр-наружу, только по допустимым выровненным точкам в [min,max]
function* zigzagAligned(start:number, step:number, min:number, max:number) {
  const [lo, hi] = alignedBounds(start, step, min, max);
  if (lo > hi) return;
  const clamp = (v:number)=> Math.max(lo, Math.min(hi, v));
  const c = clamp(start);

  yield c;
  for (let off = step; ; off += step) {
    let any = false;
    const a = c + off; if (a <= hi) { yield a; any = true; }
    const b = c - off; if (b >= lo) { yield b; any = true; }
    if (!any) break;
  }
}

// ——— Layout для Moodboard: justified-строки без отступов ———
// Возвращает [mins[], maxs[]] для рядовых карточек при высоте h и допуске eps
function rowRangesForRatios(ratios:number[], h:number, eps:number, minCell:number, maxCell:number) {
  const mins:number[] = [];
  const maxs:number[] = [];
  for (const r of ratios) {
    const rLo = Math.max(r * (1 - eps), R_MIN); // не меньше глобального минимума
    const rHi = Math.min(r * (1 + eps), R_MAX); // не больше глобального максимума
    const wMin = Math.max(minCell, Math.ceil(rLo * h));
    const wMax = Math.min(maxCell, Math.floor(rHi * h));
    mins.push(wMin);
    maxs.push(Math.max(wMax, wMin)); // safety
  }
  return { mins, maxs };
}

// ——— Колонки: обратные диапазоны по высоте при фиксированной ширине колонки w ———
function colRangesForRatios(ratios:number[], w:number, eps:number, minCell:number, maxCell:number) {
  const mins:number[] = [];
  const maxs:number[] = [];
  for (const r of ratios) {
    const rLo = Math.max(r * (1 - eps), R_MIN);
    const rHi = Math.min(r * (1 + eps), R_MAX);
    // h = w / r  → при ослаблении берём диапазон [w / rHi, w / rLo]
    const hMin = Math.max(minCell, Math.ceil(w / rHi));
    const hMax = Math.min(maxCell, Math.floor(w / rLo));
    mins.push(hMin);
    maxs.push(Math.max(hMax, hMin));
  }
  return { mins, maxs };
}

type MoodLayoutMode = 'rows' | 'cols' | 'combo';
type MoodShuffleMode = 'auto' | 'rows' | 'cols' | 'combo';
type MoodOpts = {
  fullFill: boolean;
  keepAspect: boolean;
  mode: MoodLayoutMode;
  intensity: number;   // 0..1
  columnBias: number;  // 0..1
};

function layoutMoodboardCombo(itemsIn: SBItem[], W:number, H:number, optsBase: MoodOpts): SBItem[] {
  const items = itemsIn.filter(Boolean).map(i => ({ ...i }));
  if (!items.length) return items;

  const fullFill = !!optsBase.fullFill;
  if (fullFill) shuffleInPlace(items);

  // разбиваем на 2 или 3 блока
  const blocks = (Math.random() < (0.5 + 0.4*optsBase.intensity)) ? 3 : 2;
  // случайно — вертикальные (делим W) или горизонтальные (делим H)
  const vertical = Math.random() < 0.5;

  // пропорции (мягкие, чтобы не было «узких» полос)
  const parts:number[] = [];
  let rest = 1;
  for (let i=0;i<blocks-1;i++){
    const p = clamp(Math.random()*0.5 + 0.25, 0.2, 0.6); // 0.25..0.75
    const take = (i===blocks-1) ? rest : clamp(p*rest, 0.2, rest - 0.2*(blocks-1-i));
    parts.push(take); rest -= take;
  }
  parts.push(rest);

  // раздаём айтемы пропорционально площади блока
  const counts = parts.map(p => Math.max(1, Math.round(items.length * p)));
  // поправка, чтобы сумма была ровно N
  let diff = counts.reduce((a,b)=>a+b,0) - items.length;
  while (diff !== 0) {
    for (let i=0;i<counts.length && diff!==0;i++) {
      if (diff > 0 && counts[i] > 1) { counts[i]--; diff--; }
      else if (diff < 0) { counts[i]++; diff++; }
    }
  }

  // разрезаем список и раскладываем каждый блок своим режимом
  let cursor = 0;
  let offX = 0, offY = 0;
  const out: SBItem[] = [];

  for (let bi=0; bi<blocks; bi++) {
    const cnt = counts[bi];
    const batch = items.slice(cursor, cursor + cnt).map(i => ({ ...i }));
    cursor += cnt;

    const wPart = vertical ? Math.max(1, Math.floor(W * parts[bi])) : W;
    const hPart = vertical ? H : Math.max(1, Math.floor(H * parts[bi]));

    // иногда в блоке — строки, иногда — колонки
    const mode: MoodLayoutMode = Math.random() < 0.5 ? 'rows' : 'cols';
    const opts: MoodOpts = { ...optsBase, mode, fullFill: true };

    const laid = layoutMoodboard(batch, wPart, hPart, { fullFill: true, intensity: opts.intensity });

    // сдвигаем координаты блоком
    for (const it of laid) {
      const i2 = { ...it, gx: it.gx + offX, gy: it.gy + offY };
      out.push(i2);
    }

    if (vertical) offX += wPart; else offY += hPart;
  }

  return out;
}

type MoodBspOpts = { fullFill: boolean; intensity: number }; // intensity: 0..1

type Region = { x:number; y:number; w:number; h:number; n:number; depth:number };

function computeMinSideCells(W:number, H:number, count:number, t:number, attempt:number){
  // Площадь на картинку
  const areaPer = (W*H) / Math.max(1, count);

  // Оценка "средней" стороны квадрата из этой площади
  const sideEst = Math.sqrt(areaPer);

  // Интенсивность: чем выше t — тем разрешаем мельче (больше разнообразия)
  // Попытки: каждый ретрай ещё ужимает минимум
  const intenK = 0.65 - 0.15*t;        // t=0 → 0.65, t=1 → 0.50
  const retryK = Math.max(0.35, 1 - 0.22*attempt); // 1.00, 0.78, 0.56, 0.35

  // Итоговый минимум в клетках
  const minC = Math.floor(sideEst * intenK * retryK);

  // Жёсткие рамки
  const minClamp = 2;                               // минимум — 2 клетки (32px)
  const maxClamp = Math.floor(Math.min(W,H) / 2);   // не больше половины краткой стороны
  return Math.max(minClamp, Math.min(maxClamp, minC));
}

function bspTile(count:number, W:number, H:number, t:number, attempt:number=0): Region[] {
  // динамический минимум
  const MINC = computeMinSideCells(W, H, count, t, attempt);
  const RMIN = R_MIN, RMAX = R_MAX;

  const regions: Region[] = [{ x:0, y:0, w:W, h:H, n:Math.max(1,count), depth:0 }];
  let guard = 50000;
  let debt  = 0; // "лишние" элементы от неделимых регионов

  const vRange = (w:number,h:number) => {
    const min = Math.max(MINC, Math.ceil(RMIN*h), w - Math.floor(RMAX*h));
    const max = Math.min(w - MINC, Math.floor(RMAX*h), w - Math.ceil(RMIN*h));
    return (min <= max) ? [min, max] as const : null;
  };
  const hRange = (w:number,h:number) => {
    const min = Math.max(MINC, Math.ceil(w / RMAX), h - Math.floor(w / RMIN));
    const max = Math.min(h - MINC, Math.floor(w / RMIN), h - Math.ceil(w / RMAX));
    return (min <= max) ? [min, max] as const : null;
  };

  const pickRegionIndex = () => {
    const idxs = regions.map((r,i)=>({i, a:r.w*r.h, ar:r.w/r.h, n:r.n}))
                        .filter(r=>r.n>1);
    if (!idxs.length) return -1;
    if (t > 0.6) return idxs[randInt(0, idxs.length-1)].i;
    idxs.sort((A,B)=>{
      const fa = Math.abs(Math.log(A.ar));
      const fb = Math.abs(Math.log(B.ar));
      return (fb - fa) || (B.a - A.a);
    });
    return idxs[0].i;
  };

  const allocateDebtTo = (r: Region) => {
    if (debt <= 0) return;
    r.n += debt;
    debt = 0;
  };

  while (regions.some(r=>r.n>1) && guard-- > 0) {
    const idx = pickRegionIndex();
    if (idx < 0) break;
    const r = regions[idx];

    const vr = vRange(r.w, r.h);
    const hr = hRange(r.w, r.h);

    // если совсем не делится — отдаём "долг" и фиксируем как лист
    if (!vr && !hr) {
      if (r.n > 1) debt += (r.n - 1);
      r.n = 1;
      // попробуем сразу прицепить долг к самой большой области
      const cand = regions.filter(rr => rr !== r)
                          .sort((a,b)=> (b.w*b.h) - (a.w*a.h))[0];
      if (cand) allocateDebtTo(cand);
      continue;
    }

    // ориентация разреза
    const preferV = r.w > r.h;
    const coin = Math.random();
    let tryV = coin < (0.5 + (preferV ? (0.15*(1-t)) : -(0.15*(1-t))));
    if (tryV && !vr && hr) tryV = false;
    if (!tryV && !hr && vr) tryV = true;

    // сколько элементов отправить в первую часть (с учётом возможного долга, который прилепим позже)
    const n = r.n;
    const k = randInt(1, n-1);

    // целевая доля площади
    const jitter = 0.1 + 0.35*t;
    const wantP = clamp(k / n + (Math.random()*2 - 1)*jitter, 0.15, 0.85);

    if (tryV) {
      const [wMin, wMax] = vr!;
      let w1 = clamp(Math.round(r.w * wantP), wMin, wMax);
      const left:Region  = { x:r.x,     y:r.y, w:w1,       h:r.h, n:k,       depth:r.depth+1 };
      const right:Region = { x:r.x+w1,  y:r.y, w:r.w - w1, h:r.h, n:n - k,   depth:r.depth+1 };
      // долг всегда лучше отдавать более крупному ребёнку
      const big = (left.w*left.h >= right.w*right.h) ? left : right;
      allocateDebtTo(big);
      regions.splice(idx, 1, left, right);
    } else {
      const [hMin, hMax] = hr!;
      let h1 = clamp(Math.round(r.h * wantP), hMin, hMax);
      const top:Region    = { x:r.x, y:r.y,      w:r.w, h:h1,         n:k,       depth:r.depth+1 };
      const bottom:Region = { x:r.x, y:r.y+h1,   w:r.w, h:r.h - h1,   n:n - k,   depth:r.depth+1 };
      const big = (top.w*top.h >= bottom.w*bottom.h) ? top : bottom;
      allocateDebtTo(big);
      regions.splice(idx, 1, top, bottom);
    }
  }

  // если остался долг — положим его на самый большой делимый регион и продолжим делить ещё чуть-чуть
  if (debt > 0) {
    const cand = regions
      .map((r,i)=>({r,i, vr:vRange(r.w,r.h), hr:hRange(r.w,r.h)}))
      .filter(o => (o.vr || o.hr))
      .sort((a,b)=> (b.r.w*b.r.h) - (a.r.w*a.r.h))[0];
    if (cand) {
      regions[cand.i].n += debt;
      debt = 0;
      let extraGuard = 20000;
      while (regions.some(r=>r.n>1) && extraGuard-- > 0) {
        const idx = pickRegionIndex();
        if (idx < 0) break;
        const r = regions[idx];
        const vr = vRange(r.w, r.h);
        const hr = hRange(r.w, r.h);
        if (!vr && !hr) { r.n = 1; continue; }
        const preferV = r.w > r.h;
        const coin = Math.random();
        let tryV = coin < (0.5 + (preferV ? (0.15*(1-t)) : -(0.15*(1-t))));
        if (tryV && !vr && hr) tryV = false;
        if (!tryV && !hr && vr) tryV = true;
        const k = randInt(1, r.n-1);
        const jitter = 0.1 + 0.35*t;
        const wantP = clamp(k / r.n + (Math.random()*2 - 1)*jitter, 0.15, 0.85);

        if (tryV) {
          const [wMin, wMax] = vr!;
          const w1 = clamp(Math.round(r.w * wantP), wMin, wMax);
          const A:Region  = { x:r.x,     y:r.y, w:w1,       h:r.h, n:k,         depth:r.depth+1 };
          const B:Region  = { x:r.x+w1,  y:r.y, w:r.w - w1, h:r.h, n:r.n - k,   depth:r.depth+1 };
          regions.splice(idx, 1, A, B);
        } else {
          const [hMin, hMax] = hr!;
          const h1 = clamp(Math.round(r.h * wantP), hMin, hMax);
          const A:Region    = { x:r.x, y:r.y,      w:r.w, h:h1,         n:k,         depth:r.depth+1 };
          const B:Region    = { x:r.x, y:r.y+h1,   w:r.w, h:r.h - h1,   n:r.n - k,   depth:r.depth+1 };
          regions.splice(idx, 1, A, B);
        }
      }
    }
  }

  // листья
  const leaves = regions.filter(r=>r.n===1);

  // Если всё ещё не хватает листьев — это значит, что MINC великоват.
  // Вернём сигнал: пусть вызывающий попробует меньший MINC (через attempt+1).
  return leaves;
}

function layoutMoodboard(itemsIn: SBItem[], W:number, H:number, opts: { fullFill: boolean; intensity: number }): SBItem[] {
  if (!itemsIn?.length) return [];
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    return itemsIn.filter(Boolean).map(i => ({ ...i }));
  }

  const items = itemsIn.filter(Boolean).map(i => ({ ...i }));
  if (opts.fullFill) shuffleInPlace(items);

  const count = items.length;
  let leaves: Region[] = [];
  // до 4 попыток: каждый раз динамический мин.размер ещё меньше
  for (let attempt = 0; attempt < 4; attempt++) {
    leaves = bspTile(count, W, H, opts.intensity, attempt);
    if (leaves.length === count) break;
  }

  // если вдруг всё равно не совпало — последний шанс: берём столько, сколько есть,
  // остальным отдадим самые большие листья по два (но это практически не случится с п.1–2)
  if (leaves.length !== count) {
    console.warn('[moodboard] bsp produced', leaves.length, 'of', count, '— retrying with minimal cells');
    leaves = bspTile(count, W, H, opts.intensity, 99); // максимально агрессивно: min side → 2
  }

  // сортировки по аспекту
  const byLeafRatio = leaves.map((r,idx)=>({idx, ratio: r.w / r.h})).sort((a,b)=>a.ratio-b.ratio);
  const withNat = items.map((it,idx)=>({idx, ratio: getAspect(it)}));
  if (opts.intensity < 0.2) withNat.sort((a,b)=>a.ratio-b.ratio);
  else shuffleInPlace(withNat);

  const out = items.slice();
  const N = Math.min(leaves.length, out.length);
  for (let i=0; i<N; i++) {
    const it = out[withNat[i].idx];
    const r  = leaves[byLeafRatio[i].idx];
    it.gx = r.x; it.gy = r.y; it.gw = r.w; it.gh = r.h;
  }

  // Страховка: если внезапно что-то не разложили — притянем «хвосты» в свободные листья
  for (let i=N; i<out.length; i++) {
    const r = leaves[(i - N) % leaves.length];
    const it = out[withNat[i].idx];
    it.gx = r.x; it.gy = r.y; it.gw = r.w; it.gh = r.h;
  }

  return out;
}

function getAspect(it?: SBItem): number {
  if (!it) return 4/3;
    if (typeof it.natR === 'number' && isFinite(it.natR) && it.natR > 0.01) {
      return clamp(it.natR, R_MIN, R_MAX);
    }
    const w = Number(it.natW), h = Number(it.natH);
  if (isFinite(w) && isFinite(h) && w>0 && h>0) return clamp(w/h, R_MIN, R_MAX);
    return 4/3;
}

function reflowMoodboard(prev: SBItem[], W:number, H:number, intensity100:number=40) {
  const t = Math.min(1, Math.max(0, intensity100/100));
  const laid = layoutMoodboard(prev.filter(i=>i.kind==='image' || i.kind==='video'), W, H, { fullFill:false, intensity:t });
  return hasOverlapExact(laid, W, H) ? layoutMoodboard(prev.filter(i=>i.kind==='image' || i.kind==='video'), W, H, { fullFill:true, intensity:t }) : laid;
}

function shuffleMoodboard(prev: SBItem[], W:number, H:number, intensity100:number) {
  try {
    const t = Math.min(1, Math.max(0, intensity100/100));

    // 1) базовая BSP-раскладка
    let laid = layoutMoodboard(prev.filter(i=>i.kind==='image' || i.kind==='video'), W, H, { fullFill:true, intensity:t });
    // 2) пост-дотяжка к краям
    laid = stretchToCanvasEdges(laid, W, H);

    // 3) sanity-check: пересечения запрещены
    if (hasOverlapExact(laid, W, H)) {
      console.warn('[moodboard/shuffle] overlap after stretch — re-layout once');
      // однократный перешафл без stretch (обычно конфликт даёт именно растяжка)
      const retry = layoutMoodboard(prev.filter(i=>i.kind==='image' || i.kind==='video'), W, H, { fullFill:true, intensity:t });
      if (!hasOverlapExact(retry, W, H)) return retry;

      // на всякий случай 2-й вариант: BSP+stretch, вдруг другой раскрой ок
      const retry2 = stretchToCanvasEdges(retry, W, H);
      if (!hasOverlapExact(retry2, W, H)) return retry2;

      // крайний fallback: вернём вариант без растяжки
      console.warn('[moodboard/shuffle] overlap persists — return non-stretched layout');
      return retry;
    }
    return laid;
  } catch (e) {
    console.error('[moodboard/shuffle] layout failed:', e);
    return Array.isArray(prev) ? prev.slice() : prev;
  }
}

type Dir = 'right'|'left'|'down'|'up';

function stretchToCanvasEdges(arrIn: SBItem[], W:number, H:number): SBItem[] {
  const arr = arrIn.map(i => ({ ...i }));
  const target = { minX: 0, minY: 0, maxX: W-1, maxY: H-1 };

  const tryGrow = (i: number, dir: Dir) => {
    const it = arr[i];
    const others = arr.filter((_,j)=>j!==i);

    if (dir === 'right') {
      if (it.gx + it.gw - 1 < target.maxX &&
          canPlaceWithStdGutter(it.gx, it.gy, it.gw+1, it.gh, others, W, H)) { it.gw+=1; return true; }
    } else if (dir === 'left') {
      if (it.gx > target.minX &&
          canPlaceWithStdGutter(it.gx-1, it.gy, it.gw+1, it.gh, others, W, H)) { it.gx-=1; it.gw+=1; return true; }
    } else if (dir === 'down') {
      if (it.gy + it.gh - 1 < target.maxY &&
          canPlaceWithStdGutter(it.gx, it.gy, it.gw, it.gh+1, others, W, H)) { it.gh+=1; return true; }
    } else {
      if (it.gy > target.minY &&
          canPlaceWithStdGutter(it.gx, it.gy-1, it.gw, it.gh+1, others, W, H)) { it.gy-=1; it.gh+=1; return true; }
    }
    return false;
  };

  // порядок обхода: сначала тянем к левому/верхнему краю (чтобы «прилипли»),
  // потом к правому/нижнему (закрываем финальные щели)
  const stages: Dir[] = ['left','up','right','down'];

  // упорядочиваем индексы под конкретный этап (к ближайшему краю)
  const sortFor = (dir: Dir) => {
    const idxs = arr.map((_,i)=>i);
    if (dir==='left')  idxs.sort((a,b)=>arr[a].gx - arr[b].gx);
    if (dir==='right') idxs.sort((a,b)=> (arr[b].gx + arr[b].gw) - (arr[a].gx + arr[a].gw));
    if (dir==='up')    idxs.sort((a,b)=>arr[a].gy - arr[b].gy);
    if (dir==='down')  idxs.sort((a,b)=> (arr[b].gy + arr[b].gh) - (arr[a].gy + arr[a].gh));
    return idxs;
  };

  // ограничиваем по площади (работа быстрая, но не бесконечная)
  const targetArea = (target.maxX - target.minX + 1) * (target.maxY - target.minY + 1);
  const curArea = arr.reduce((s,it)=>s + it.gw*it.gh, 0);
  const missing = Math.max(0, targetArea - curArea);
  const maxIters = Math.max(1000, missing * 8);

  let changed = true, iter = 0;
  while (changed && iter < maxIters) {
    changed = false;
    for (const dir of stages) {
      const idxs = sortFor(dir);
      for (const i of idxs) {
        while (tryGrow(i, dir)) {
          changed = true;
          if (++iter >= maxIters) break;
        }
        if (iter >= maxIters) break;
      }
      if (iter >= maxIters) break;
    }
  }
  return arr;
}

// Сдвиг выбранной разделяющей линии на delta клеток (delta может быть отриц.)
// Возвращает { next, applied } — новый список и реально применённый delta (с учётом клампа)
function computeEdgeShift(
  prev: SBItem[],
  id: string,
  edge: Dir,          // 'left'|'right'|'up'|'down'
  delta: number,
  W: number,          // в клетках
  H: number           // в клетках
): { next: SBItem[]; applied: number } {
  if (!delta) return { next: prev, applied: 0 };

  const items = prev.map(i => ({ ...i }));
  const itIdx = items.findIndex(i => i.id === id);
  if (itIdx < 0) return { next: prev, applied: 0 };
  const it = items[itIdx];

  if (edge === 'left' || edge === 'right') {
    // общая вертикальная линия x0
    const x0 = (edge === 'right') ? (it.gx + it.gw) : it.gx;

    // слева от линии — те, у кого правый край == x0
    const leftIdxs  = items.map((v,j)=>({v,j})).filter(o => o.v.gx + o.v.gw === x0).map(o=>o.j);
    // справа от линии — те, у кого левый край == x0
    const rightIdxs = items.map((v,j)=>({v,j})).filter(o => o.v.gx === x0).map(o=>o.j);

    if (!leftIdxs.length || !rightIdxs.length) return { next: prev, applied: 0 };

    // допустимый диапазон delta (чтобы ни у кого не стало gw < 1 и не вылезли за мир)
    let lo = -Infinity, hi = Infinity;

    // ЛЕВАЯ сторона: gw' = gw + d  →  d ≥ 1 - gw;  и gx + gw + d ≤ W  →  d ≤ W - (gx + gw)
    for (const j of leftIdxs) {
      const L = items[j];
      lo = Math.max(lo, 1 - L.gw);
      hi = Math.min(hi, W - (L.gx + L.gw));
    }

    // ПРАВАЯ сторона: gx' = gx + d, gw' = gw - d → gw - d ≥ 1 → d ≤ gw - 1; gx + d ≥ 0 → d ≥ -gx
    for (const j of rightIdxs) {
      const R = items[j];
      hi = Math.min(hi, R.gw - 1);
      lo = Math.max(lo, -R.gx);
    }

    const d = Math.trunc(clamp(delta, Math.ceil(lo), Math.floor(hi)));
    if (!d) return { next: prev, applied: 0 };

    for (const j of leftIdxs)  items[j].gw += d;
    for (const j of rightIdxs) { items[j].gx += d; items[j].gw -= d; }

    return { next: items, applied: d };
  } else {
    // Горизонтальная линия y0
    const y0 = (edge === 'down') ? (it.gy + it.gh) : it.gy;

    const topIdxs    = items.map((v,j)=>({v,j})).filter(o => o.v.gy + o.v.gh === y0).map(o=>o.j);
    const bottomIdxs = items.map((v,j)=>({v,j})).filter(o => o.v.gy === y0).map(o=>o.j);

    if (!topIdxs.length || !bottomIdxs.length) return { next: prev, applied: 0 };

    // Верх: gh' = gh + d → d ≥ 1 - gh; gy + gh + d ≤ H → d ≤ H - (gy + gh)
    let lo = -Infinity, hi = Infinity;
    for (const j of topIdxs) {
      const T = items[j];
      lo = Math.max(lo, 1 - T.gh);
      hi = Math.min(hi, H - (T.gy + T.gh));
    }

    // Низ: gy' = gy + d; gh' = gh - d → d ≤ gh - 1;  gy + d ≥ 0 → d ≥ -gy
    for (const j of bottomIdxs) {
      const B = items[j];
      hi = Math.min(hi, B.gh - 1);
      lo = Math.max(lo, -B.gy);
    }

    const d = Math.trunc(clamp(delta, Math.ceil(lo), Math.floor(hi)));
    if (!d) return { next: prev, applied: 0 };

    for (const j of topIdxs) items[j].gh += d;
    for (const j of bottomIdxs) { items[j].gy += d; items[j].gh -= d; }

    return { next: items, applied: d };
  }
}


function AppInner() {
  const [board, setBoard] = useState<BoardKey>("moodboard");
  const [items, setItems] = useState<SBItem[]>(() => loadBoard("moodboard"));
  // Только интенсивность для Moodboard
  const [moodShuffleIntensity, setMoodShuffleIntensity] = useState<number>(40); // 0..100

  async function pasteLinkFromClipboard() {
    try {
      await ensureClipboardReadPermission();
      const text = (await navigator.clipboard.readText() || '').trim();
      if (!(await validateUrl(text))) {
        showToast('Link is not avaliable', 'err');
        return;
      }
      await addUrl(text);
    } catch {
      showToast('Clipboard permission required', 'err');
    }
  }

  async function pasteImageFromClipboard() {
    try {
      await ensureClipboardReadPermission();
      if (!('clipboard' in navigator) || !('read' in navigator.clipboard)) {
        showToast('Clipboard API is not available', 'err');
        return;
      }
      // @ts-ignore
      const items: ClipboardItem[] = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (!type) continue;
        const blob = await it.getType(type);
        await addImageBlob(blob);
        return;
      }
      showToast('No image in clipboard', 'err');
    } catch {
      showToast('Clipboard permission required', 'err');
    }
  }

  async function probeImageFromBlob(blob: Blob): Promise<{w:number;h:number}> {
    const obj = URL.createObjectURL(blob);
    try { return await probeImage(obj); }
    finally { URL.revokeObjectURL(obj); }
  }

  async function addImageBlob(blob: Blob) {
    const dim = await probeImageFromBlob(blob);
    const { gw, gh } = cellsFromPxNoCrop(dim.w, dim.h);
    
    let url: string;
    if (remoteReadyRef.current) {
      url = await blobToDataURL(blob); // для БД — data:URL
    } else {
      const id = await idbPutBlob(blob); // твой текущий путь в IndexedDB
      url = IDB_URL_PREFIX + id;
    }

    setItemsUndo(prev => {
      const curBoard = boardRef.current;
      const curW = WRef.current, curH = HRef.current;
      if (curBoard === 'moodboard') {
        const it: SBItem = { id: uid(), url, kind: 'image', gx: 0, gy: 0, gw, gh, approved: false };
        const laid = reflowMoodboard([...prev, it], curW, curH, moodShuffleIntensity);
        showToast('Added', 'ok');
        // Добавляем натуральные размеры для moodboard
        assignNatSizeToItem(it, blob);
        return laid;
      }

      // — styleboard как было —
      console.time('place');
      const pos = findPlacementSnakePacked(prev, gw, gh, curW, curH);
      console.timeEnd('place');
      if (!pos) { showToast('Canvas size is limited', 'err'); return prev; }
      const it: SBItem = { id: uid(), url, kind: 'image', gx: pos.gx, gy: pos.gy, gw, gh, approved: false };
      showToast('Added', 'ok');
      if (LOG.placement) {
        const idx = prev.length + 1;
        console.log(`#${idx} image ${gw}x${gh} gx=${pos.gx} gy=${pos.gy} px=(${pos.gx*GRID},${pos.gy*GRID})`);
      }
      return [...prev, it];
    });
  }

  // ——— репакет "как при авто-подстановке" (в текущем порядке items) ———
  function repackLikeAuto(prev: SBItem[], W:number, H:number): SBItem[] {
    const placed: SBItem[] = [];
    for (const it of prev) {
      const pos = findPlacementSnakePacked(placed, it.gw, it.gh, W, H) ?? spawnFor(it.gw, it.gh, W, H);
      placed.push({ ...it, gx: pos.gx, gy: pos.gy });
    }
    return placed;
  }

  // Преобразуем локальные idb:// ссылки в data:URL (чтобы шарились между браузерами)
  async function upgradeIdbUrls(arr: SBItem[]): Promise<SBItem[]> {
    const next: SBItem[] = [];
    for (const it of arr) {
      if (isIdbUrl(it.url)) {
        const blob = await idbGetBlob(idFromIdbUrl(it.url));
        if (blob) {
          const dataUrl = await blobToDataURL(blob);
          next.push({ ...it, url: dataUrl });
        } else {
          next.push(it); // не нашли blob — оставим как есть
        }
      } else {
        next.push(it);
      }
    }
    return next;
  }

  // Мгновенная отправка без дебаунса (используем тот же API, что и в remote.ts)
  async function flushToCloudNow(pass: string) {
    const API = (import.meta as any).env?.VITE_API_BASE || '/api';
    const payload = { board: boardRef.current, items: itemsRef.current, pass };
    const r = await fetch(`${API}?op=save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pass': pass },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  }

  // Принудительная запись пустого списка в БД (для любого борда)
  async function flushBoardToCloud(boardKey: BoardKey, itemsNow: SBItem[], pass: string) {
    const API = (import.meta as any).env?.VITE_API_BASE || '/api';
    const r = await fetch(`${API}?op=save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pass': pass },
      body: JSON.stringify({ board: boardKey, items: itemsNow })
    });
    if (!r.ok) throw new Error(await r.text());
  }

  function collectFill() {
    setItemsUndo(prev => {
      if (!prev.length) return prev;
      const repacked  = repackLikeAuto(prev, W, H);         // 1) убрать «дыры»
      const collected = collectCompute(repacked, W, H);     // 2) растянуть
      return collected;
    });
    showToast('Collected', 'ok');
  }

  // ——— чистая "растяжка до tight-бокса" с учётом стандартного GUTTER ———
  function collectCompute(arrIn: SBItem[], W:number, H:number): SBItem[] {
    const arr = arrIn.map(i => ({ ...i }));
    const target = getBBoxTight(arr)!;

    type Dir = 'right'|'left'|'down'|'up';
    const dirs: Dir[] = ['right','left','down','up'];
    const order = arr
      .map((it, idx) => ({ idx, key: it.gx * 100000 + it.gy }))
      .sort((a,b)=>a.key - b.key)
      .map(o => o.idx);

    const tryGrow = (i: number, dir: Dir) => {
      const it = arr[i];
      const others = arr.filter((_,j)=>j!==i);

      if (dir === 'right') {
        if (it.gx + it.gw <= target.maxX &&
            canPlaceWithStdGutter(it.gx, it.gy, it.gw+1, it.gh, others, W, H)) { it.gw+=1; return true; }
      } else if (dir === 'left') {
        if (it.gx - 1 >= target.minX &&
            canPlaceWithStdGutter(it.gx-1, it.gy, it.gw+1, it.gh, others, W, H)) { it.gx-=1; it.gw+=1; return true; }
      } else if (dir === 'down') {
        if (it.gy + it.gh <= target.maxY &&
            canPlaceWithStdGutter(it.gx, it.gy, it.gw, it.gh+1, others, W, H)) { it.gh+=1; return true; }
      } else {
        if (it.gy - 1 >= target.minY &&
            canPlaceWithStdGutter(it.gx, it.gy-1, it.gw, it.gh+1, others, W, H)) { it.gy-=1; it.gh+=1; return true; }
      }
      return false;
    };

    // адаптивная остановка
    const targetArea = (target.maxX - target.minX + 1) * (target.maxY - target.minY + 1);
    const curArea = arr.reduce((s,it)=>s + it.gw*it.gh, 0);
    const missing = Math.max(0, targetArea - curArea);
    const maxIters = Math.max(1000, missing * 8);

    let changed = true, iter = 0;
    while (changed && iter < maxIters) {
      changed = false;
      for (const dir of dirs) {
        const idxs = (dir === 'left' || dir === 'up') ? [...order].reverse() : order;
        for (const i of idxs) {
          while (tryGrow(i, dir)) {
            changed = true;
            if (++iter >= maxIters) break;
          }
          if (iter >= maxIters) break;
        }
        if (iter >= maxIters) break;
      }
    }
    return arr;
  }

  // прием Ctrl/Cmd+V без поля ввода
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;

      // 1) Картинка из буфера (в приоритете)
      const items = Array.from(dt.items || []);
      const imgIt = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (imgIt) {
        e.preventDefault();
        const file = imgIt.getAsFile();
        if (file) await addImageBlob(file);
        return;
      }

      // 2) Ссылка текстом
      const text = (dt.getData('text') || '').trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        if (!(await validateUrl(text))) {
          showToast('Link is not avaliable', 'err');
          return;
        }
        await addUrl(text);
      }
    };

    window.addEventListener('paste', onPaste as any);
    return () => window.removeEventListener('paste', onPaste as any);
  }, [board]); // ← теперь хэндлер перевешивается при смене борда

  // camera
  const [cameraByBoard, setCameraByBoard] = useState<{[K in BoardKey]: {scale:number; tx:number; ty:number}}>(() => ({
    moodboard:  { scale: 1, tx: 0, ty: 0 },
    styleboard: { scale: 1, tx: 0, ty: 0 },
  }));
  const cam = cameraByBoard[board];
  const scale = cam.scale, tx = cam.tx, ty = cam.ty;

  function setCam(patch: Partial<{scale:number;tx:number;ty:number}>) {
    setCameraByBoard(prev => ({ ...prev, [board]: { ...prev[board], ...patch }}));
  }

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);

  // undo/redo
  const historyRef = useRef<SBItem[][]>([]);
  const redoRef    = useRef<SBItem[][]>([]);
  const MAX_HIST = 20;

  // хранить «актуальные» items для синхронного расчёта
  const itemsRef = useRef(items);
  useEffect(()=>{ itemsRef.current = items; }, [items]);

  // remote functionality refs
  const passRef = useRef<string | null>(sessionStorage.getItem('sb:pass'));
  const remoteReadyRef = useRef<boolean>(false);

  // единичный пуш в историю на старте перетаскивания
  const resizingRef = useRef(false);
  function onEdgeDragStart() {
    if (!resizingRef.current) {
      // один снимок в undo перед серией live-апдейтов
      historyRef.current.push(items.map(i=>({...i})));
      resizingRef.current = true;
    }
  }
  function onEdgeDragEnd() {
    resizingRef.current = false;
  }

  // live-сдвиг линии; возвращает реально применённый delta (0, если упёрлись)
  function onEdgeDrag(id: string, edge: Dir, delta: number): number {
    if (!delta) return 0;
    const { next, applied } = computeEdgeShift(itemsRef.current, id, edge, delta, W, H);
    if (applied) setItems(next);
    return applied;
  }

  function cloneSnap(arr: SBItem[]) { return arr.map(i => ({ ...i })); }

  function pushHistory(snapshot: SBItem[]) {
    historyRef.current.push(cloneSnap(snapshot));
    if (historyRef.current.length > MAX_HIST) historyRef.current.shift();
    // любое новое действие обнуляет "будущее"
    redoRef.current = [];
  }

  function setItemsUndo(updater: (prev:SBItem[]) => SBItem[]) {
    setItems(prev => {
      pushHistory(prev);
      return updater(prev);
    });
  }

  function undoLast() {
    setItems(prev => {
      const snap = historyRef.current.pop();
      if (!snap) return prev;
      // текущий в будущее (для Redo)
      redoRef.current.push(cloneSnap(prev));
      return snap;
    });
  }

  function redoLast() {
    setItems(prev => {
      const snap = redoRef.current.pop();
      if (!snap) return prev;
      // текущий в прошлое (чтобы можно было снова Undo)
      historyRef.current.push(cloneSnap(prev));
      return snap;
    });
  }

  // canvas size per board
  const [canvasByBoard, setCanvasByBoard] = useState<{[K in BoardKey]: {w:number; h:number}}>(() => ({
    moodboard:  { w: 3840, h: 2160 },  // чётная кратность 1920×1080
    styleboard: { w: 12000, h: 12000 },
  }));

  const canvas = canvasByBoard[board];
  const canvasW = canvas.w;
  const canvasH = canvas.h;

  // форма ввода привязана к активному табу
  const [formW, setFormW] = useState(canvasW.toString());
  const [formH, setFormH] = useState(canvasH.toString());
  const [recalculatedW, setRecalculatedW] = useState<number | null>(null);
  const [recalculatedH, setRecalculatedH] = useState<number | null>(null);

  // Состояние для тяжелых действий
  const [heavyBusy, setHeavyBusy] = useState(false);
  const [heavyCooldown, setHeavyCooldown] = useState(false);

  async function runHeavy(label: 'collect'|'shuffle', job: () => void) {
    if (heavyBusy || heavyCooldown) {
      showToast(heavyBusy ? 'Выполняется…' : 'Подождите…', 'err');
      return;
    }
    setHeavyBusy(true);
    // дать React прорендерить прогресс-бар
    await new Promise(requestAnimationFrame);
    await new Promise(res => setTimeout(res, 0));
    try {
      job(); // сам тяжёлый расчёт (синхронный)
    } finally {
      // небольшая пауза, чтобы «бегущая» полоса не мигала
      await new Promise(res => setTimeout(res, 200));
      setHeavyBusy(false);
      setHeavyCooldown(true);
      setTimeout(() => setHeavyCooldown(false), 500); // 500ms «анти-дребезг»
    }
  }
  useEffect(() => {
    setFormW(canvasW.toString());
    setFormH(canvasH.toString());
    setRecalculatedW(null);
    setRecalculatedH(null);
  }, [board, canvasW, canvasH]);

  const W = Math.floor(canvasW / GRID);
  const H = Math.floor(canvasH / GRID);

  // Refs для актуальных значений в обработчиках событий
  const boardRef = useRef(board);
  const WRef = useRef(W);
  const HRef = useRef(H);
  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { WRef.current = W; }, [W]);
  useEffect(() => { HRef.current = H; }, [H]);

  function getCandidateDimsFromForm(): {w:number; h:number} {
    // Используем пересчитанные значения, если они есть
    if (recalculatedW !== null && recalculatedH !== null) {
      return { w: recalculatedW, h: recalculatedH };
    }
    
    if (board==='moodboard') {
      // Применяем снап к чётной кратности HD
      const wRaw = parseInt(formW||'0',10) || 0;
      const hRaw = parseInt(formH||'0',10) || 0;
      const snapped = snapToEvenHDMultiple(wRaw, hRaw);
      return { w: snap16(snapped.w), h: snap16(snapped.h) };
    } else {
      return {
        w: sanitizeStyleField(formW),
        h: sanitizeStyleField(formH),
      };
    }
  }
  const cand = getCandidateDimsFromForm();
  // Different limits for different boards
  const minLimit = board === 'styleboard' ? 1920 : CANVAS_LIMITS.MIN;
  const outOfRange =
    cand.w < minLimit || cand.h < minLimit ||
    cand.w > CANVAS_LIMITS.MAX || cand.h > CANVAS_LIMITS.MAX;

  const smallerThanCurrent = items.length > 0 && ((cand.w < canvasW) || (cand.h < canvasH));
  const applyDisabled = outOfRange || smallerThanCurrent;
  const hasRecalculated = recalculatedW !== null && recalculatedH !== null;

  function recalculateDimensions() {
    if (board==='moodboard') {
      const wRaw = parseInt(formW||'0',10) || 0;
      const hRaw = parseInt(formH||'0',10) || 0;
      const snapped = snapToEvenHDMultiple(wRaw, hRaw);
      setRecalculatedW(snap16(snapped.w));
      setRecalculatedH(snap16(snapped.h));
    } else {
      setRecalculatedW(sanitizeStyleField(formW));
      setRecalculatedH(sanitizeStyleField(formH));
    }
  }

  function applyCanvasSize(){
    // Если нет пересчитанных значений, сначала пересчитываем
    if (!hasRecalculated) {
      recalculateDimensions();
      return;
    }

    const { w: newW, h: newH } = getCandidateDimsFromForm();
    // Different limits for different boards
    const minLimit = board === 'styleboard' ? 1920 : CANVAS_LIMITS.MIN;
    if (newW < minLimit || newH < minLimit) return;
    if (newW > CANVAS_LIMITS.MAX || newH > CANVAS_LIMITS.MAX) return;
    if (items.length > 0 && (newW < canvasW || newH < canvasH)) return; // защита только при наличии материалов

    // 1) применяем размеры пер-борда
    setCanvasByBoard(prev => ({ ...prev, [board]: { w: newW, h: newH }}));

    // 2) обновляем поля формы с применёнными значениями
    setFormW(String(newW));
    setFormH(String(newH));

    // 3) сбрасываем пересчитанные значения
    setRecalculatedW(null);
    setRecalculatedH(null);

    // 4) пересчёт позиций под новый W/H (в клетках)
    const Wn = Math.floor(newW / GRID);
    const Hn = Math.floor(newH / GRID);

    if (board === 'moodboard') {
      setItemsUndo(prev => reflowMoodboard(prev, Wn, Hn, moodShuffleIntensity));
    } else {
      setItemsUndo(prev => repackLikeAuto(prev, Wn, Hn));
    }

    setShouldCenter(true);
    showToast('Canvas updated', 'ok');
  }

  // внутри AppInner, рядом с другими хелперами
  function zoomAt(factor: number) {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - tx) / scale;
    const wy = (cy - ty) / scale;
    const nextScale = clamp(round2(scale * factor), 0.05, 3);
    const nextTx = cx - wx * nextScale;
    const nextTy = cy - wy * nextScale;
    setCam({ scale: nextScale, tx: nextTx, ty: nextTy });
  }

  const isPanningRef = useRef(false);
  const startRef = useRef<{x:number;y:number;tx:number;ty:number}|null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // === toast ===
  type ToastKind = 'ok' | 'err';
  const [toast, setToast] = useState<{text:string; kind:ToastKind} | null>(null);
  const toastTimer = useRef<number | null>(null);
  function showToast(text:string, kind:ToastKind) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = window.setTimeout(() => setToast(null), 1200) as any;
  }

  // Стартовая центровка «происхождения» полотна (а не верхний левый угол)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    
    // Центрируем только при смене доски или если камера в исходном положении
    if (tx !== 0 || ty !== 0) return;

    const HEADER = 52;
    const rect = el.getBoundingClientRect();
    const viewportCx = rect.width / 2;
    const viewportCy = HEADER + (rect.height - HEADER) / 2;

    // Центруем на центре CANVAS (а не на origin (0,0))
    setCam({ tx: viewportCx - canvasW / 2, ty: viewportCy - canvasH / 2 });
  }, [board, canvasW, canvasH]);

  // Отдельный эффект для центрирования при Reset
  const [shouldCenter, setShouldCenter] = useState(false);
  useLayoutEffect(() => {
    if (!shouldCenter) return;
    
    const el = containerRef.current;
    if (!el) return;

    const HEADER = 52;
    const rect = el.getBoundingClientRect();
    const viewportCx = rect.width / 2;
    const viewportCy = HEADER + (rect.height - HEADER) / 2;

    setCam({ tx: viewportCx - canvasW / 2, ty: viewportCy - canvasH / 2 });
    setShouldCenter(false);
  }, [shouldCenter, canvasW, canvasH]);

  useEffect(() => {
    if (!remoteReadyRef.current) {
      setItems(loadBoard(board));
    }
  }, [board]);
  useEffect(() => {
    saveBoard(board, items);
    if (remoteReadyRef.current && passRef.current) {
      remoteSave(board as any, items as any[], passRef.current);
    }
  }, [board, items]);

  // Remote data loading
  useEffect(() => {
    (async () => {
      // пробуем подцепить удалённые данные при старте
      const data = await remoteLoad('moodboard');
      if (Array.isArray(data)) {
        remoteReadyRef.current = true;   // включаем «облако» даже если в БД пока пусто
        setItems(data as any);           // пустой массив тоже валиден
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Чистим undo/redo при смене борда
  useEffect(() => {
    historyRef.current = [];
    redoRef.current = [];
  }, [board]);

  // при смене борда — тоже пробуем удалённо
  useEffect(() => {
    (async () => {
      const data = await remoteLoad(board as any);
      if (Array.isArray(data)) setItems(data as any);
    })();
  }, [board]);

  // URL-флаг для очистки всего
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shouldClear = params.get('sb') === 'clear' || params.get('sbclear') === '1';

    if (!shouldClear) return;

    // 1) localStorage
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith('styleboard:')) localStorage.removeItem(k);
    });

    // 2) IndexedDB
    idbDrop().then(() => {
      console.info('[styleboard] IDB dropped via ?sb=clear');
    });

    // 2.5) забываем пароль локально
    sessionStorage.removeItem('sb:pass');
    passRef.current = null;

    // 3) локальный стейт
    setItems([]);

    // 4) попытка очистить БД (по возможности)
    (async () => {
      // спросим пароль, если его нет в сессии
      const pwd = passRef.current || sessionStorage.getItem('sb:pass') || (prompt('Password to clear remote DB (optional):') || '');
      if (pwd) {
        try {
          await Promise.all([
            flushBoardToCloud('moodboard', [], pwd),
            flushBoardToCloud('styleboard', [], pwd),
          ]);
          // вернём пароль в сессию (удобно для следующей записи)
          passRef.current = pwd;
          sessionStorage.setItem('sb:pass', pwd);
          remoteReadyRef.current = true;
          console.info('[styleboard] remote DB cleared');
        } catch (e) {
          console.warn('[styleboard] remote DB clear failed', e);
        }
      } else {
        console.info('[styleboard] remote DB not cleared (no password provided)');
      }
    })();

    // 5) убрать флаг из URL
    params.delete('sb');
    params.delete('sbclear');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);

    console.info('[styleboard] storage cleared via ?sb=clear');
  }, []);

  useEffect(() => {
    if (!LOG.itemsTable) return;
    console.groupCollapsed(`[items] ${board} (count=${items.length})`);
    console.table(items.map(i => ({
      id: i.id.slice(-4),
      kind: i.kind,
      gx: i.gx, gy: i.gy, gw: i.gw, gh: i.gh,
      left: i.gx * GRID, top: i.gy * GRID,
      w: i.gw * GRID, h: i.gh * GRID
    })));
    console.groupEnd();
  }, [items, board]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // не крадём у инпутов
      const tgt = e.target as HTMLElement | null;
      const isForm = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
      if (isForm) return;

      // Redo: Cmd+Shift+Z или Ctrl+Y
      if (meta && ( (e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoLast();
        return;
      }

      // Undo: Cmd/Ctrl+Z
      if (meta && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        undoLast();
        return;
      }

      if (meta && (e.key === "+" || e.key === "=")) {
        e.preventDefault(); zoomAt(1.1);
      } else if (meta && (e.key === "-")) {
        e.preventDefault(); zoomAt(1/1.1);
      } else if (meta && (e.key === "0")) {
        e.preventDefault(); setCam({ scale: 1, tx: 0, ty: 0 }); setShouldCenter(true);
      }
      if ((e.key === "a" || e.key === "A") && items.length) {
        const id = items[items.length - 1].id;
        setItemsUndo(arr => arr.map(i => i.id === id ? { ...i, approved: !i.approved } : i));
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        setItemsUndo(arr => {
          const next = arr.slice(0, -1);
          return boardRef.current==='moodboard' ? reflowMoodboard(next, WRef.current, HRef.current, moodShuffleIntensity) : next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, undoLast, redoLast, board]); // ← тоже обновляемся

  // Wheel zoom (Ctrl/Cmd + wheel), cursor-centered
  useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Поддержка Ctrl+колесо и Cmd+колесо (для macOS Chrome)
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!el.contains(e.target as Node)) return;

      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const wx = (cx - tx) / scale;
      const wy = (cy - ty) / scale;

      const factor = Math.exp(-e.deltaY * 0.0015); // deltaY>0 — отдаление
      const nextScale = clamp(Math.round(scale * factor * 100) / 100, 0.05, 3);

      const nextTx = cx - wx * nextScale;
      const nextTy = cy - wy * nextScale;

      setCam({ scale: nextScale, tx: nextTx, ty: nextTy });
    };

    el.addEventListener('wheel', onWheel as EventListener, { passive: false });

    return () => {
      el.removeEventListener('wheel', onWheel as EventListener);
    };
  // 👇 ключевой момент: реакция на появление/смену DOM-узла
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef.current, board, scale, tx, ty]);

  // Panning with Space (Miro-like)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const spaceActive = (window as any)._sb_spaceHeld === true;
      const ctrlActive = (window as any)._sb_ctrlHeld === true || e.ctrlKey === true;
      if (!(spaceActive || ctrlActive)) return;
      if (containerRef.current && containerRef.current.contains(target)) {
        e.preventDefault();
        isPanningRef.current = true;
        startRef.current = { x: e.clientX, y: e.clientY, tx, ty };
        (document.body as any).style.cursor = "grabbing";
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!isPanningRef.current || !startRef.current) return;
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      setCam({ tx: startRef.current.tx + dx, ty: startRef.current.ty + dy });
    };
    const onUp = () => {
      isPanningRef.current = false;
      startRef.current = null;
      (document.body as any).style.cursor = "default";
    };
    const onKey = (e: KeyboardEvent) => {
      // Space — как было
      if (e.code === "Space") {
        const held = e.type === "keydown";
        (window as any)._sb_spaceHeld = held;
        setSpaceHeld(held);
        if (held) e.preventDefault();
      }
      // Ctrl — панорамирование и блок iframe (как Space)
      (window as any)._sb_ctrlHeld = e.ctrlKey;
      setCtrlHeld(e.ctrlKey);
    };

    const el = containerRef.current;
    const onContext = (e: MouseEvent) => { if (ctrlHeld) e.preventDefault(); };

    window.addEventListener("keydown", onKey as EventListener, { passive: false });
    window.addEventListener("keyup", onKey as EventListener);
    window.addEventListener("mousedown", onDown as EventListener);
    window.addEventListener("mousemove", onMove as EventListener);
    window.addEventListener("mouseup", onUp as EventListener);
    if (el) el.addEventListener('contextmenu', onContext as EventListener);
    
    return () => {
      window.removeEventListener("keydown", onKey as EventListener);
      window.removeEventListener("keyup", onKey as EventListener);
      window.removeEventListener("mousedown", onDown as EventListener);
      window.removeEventListener("mousemove", onMove as EventListener);
      window.removeEventListener("mouseup", onUp as EventListener);
      if (el) el.removeEventListener('contextmenu', onContext as EventListener);
    };
  }, [tx, ty, ctrlHeld]);

  async function addUrl(u: string) {
    const trimmed = u.trim();
    if (!trimmed) return;

    const kind = detectKind(trimmed);

    // перевод в клетки с привязкой к 16px
    let gw:number, gh:number;
    let s: {w:number; h:number} | null = null;
    if (kind === 'site') {
      gw = Math.ceil(TILE_IFRAME_W);  // 90
      gh = Math.ceil(TILE_IFRAME_H);  // 68
    } else {
      s = kind==='image' ? await probeImage(trimmed) : await probeVideo(trimmed);
      const capped = capToMaxSide(s.w, s.h);
      ({ gw, gh } = cellsFromPxNoCrop(capped.w, capped.h));
      if (kind === 'image') {
        console.log('[img dims]', { orig: s, capped, ratio: round2((capped.w)/(capped.h)), cells: {gw,gh} });
      }
    }

    setItemsUndo(prev => {
      const curBoard = boardRef.current;
      const curW = WRef.current, curH = HRef.current;
      if (curBoard === 'moodboard') {
        const it: SBItem = {
          id: uid(),
          url: trimmed,
          kind,            // 'image' ИЛИ 'video'
          gx: 0, gy: 0, gw, gh,
          approved: false,
          // ▼ нат. размер — важен для getAspect()
          natW: s?.w, natH: s?.h, natR: (s && s.w > 0 && s.h > 0) ? (s.w/s.h) : undefined,
        };
        const laid = reflowMoodboard([...prev, it], curW, curH, moodShuffleIntensity);
        showToast('Added', 'ok');
        // Для изображений из URL добавляем натуральные размеры асинхронно
        if (kind === 'image') {
          fetch(trimmed)
            .then(response => response.blob())
            .then(blob => assignNatSizeToItem(it, blob))
            .catch(() => { /* игнорируем ошибки */ });
        }
        return laid;
      }

      // — styleboard: только snake-packed, без site-спец.логики —
      // gw/gh уже посчитаны (для image/video — через cellsFromPxNoCrop)
      console.time('place');
      const pos = findPlacementSnakePacked(prev, gw, gh, curW, curH);
      console.timeEnd('place');
      if (!pos) { console.warn('[styleboard] no space'); showToast('Canvas size is limited', 'err'); return prev; }
      const it: SBItem = { id: uid(), url: trimmed, kind, gx: pos.gx, gy: pos.gy, gw, gh, approved: false };
      showToast('Added', 'ok');
      if (LOG.placement) {
        const idx = prev.length + 1;
        console.log(`#${idx} ${kind} ${gw}x${gh} gx=${pos.gx} gy=${pos.gy} px=(${pos.gx*GRID},${pos.gy*GRID})`);
      }
      return [...prev, it];
    });
  }



  return (
    <div className="h-screen w-screen bg-black text-neutral-200 select-none">
      {SBProgressCSS}
      {/* Top bar */}
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center gap-3 px-4 py-2 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">

        {/* Tabs */}
        <div className="flex rounded-xl overflow-hidden border border-neutral-800">
          {BOARD_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setBoard(k)}
              className={`px-3 py-1.5 text-sm capitalize ${board===k?"bg-neutral-800 text-white":"text-neutral-300 hover:bg-neutral-900"}`}
            >{k}</button>
          ))}
        </div>

        {/* Canvas size + Paste + Collect */}
        <div className="ml-2 flex items-center gap-2">
          <label className="text-xs text-neutral-400">W</label>
          <input
            value={formW}
            onChange={(e)=>setFormW(e.target.value.replace(/[^\d]/g,""))}
            onBlur={()=>{
              if (board==='moodboard') {
                const { w, h } = sanitizeMoodFromWidth(formW);
                setFormW(String(w)); setFormH(String(h));
              } else {
                setFormW(String(sanitizeStyleField(formW)));
              }
              // Сбрасываем пересчитанные значения при изменении полей
              setRecalculatedW(null);
              setRecalculatedH(null);
            }}
            className={`w-24 px-2 py-1.5 text-sm rounded bg-neutral-900 border outline-none focus:border-neutral-600 ${
              outOfRange ? "border-red-700" : "border-neutral-800"
            }`}
            placeholder="px"
            inputMode="numeric"
          />
          <label className="text-xs text-neutral-400">H</label>
          <input
            value={formH}
            onChange={(e)=>setFormH(e.target.value.replace(/[^\d]/g,""))}
            onBlur={()=>{
              if (board==='moodboard') {
                const { w, h } = sanitizeMoodFromHeight(formH);
                setFormW(String(w)); setFormH(String(h));
              } else {
                setFormH(String(sanitizeStyleField(formH)));
              }
              // Сбрасываем пересчитанные значения при изменении полей
              setRecalculatedW(null);
              setRecalculatedH(null);
            }}
            className={`w-24 px-2 py-1.5 text-sm rounded bg-neutral-900 border outline-none focus:border-neutral-600 ${
              outOfRange ? "border-red-700" : "border-neutral-800"
            }`}
            placeholder="px"
            inputMode="numeric"
          />
          <button 
            onClick={applyCanvasSize} 
            disabled={applyDisabled}
            className={`px-3 h-8 rounded-md border text-xs ${
              applyDisabled
                ? "opacity-50 cursor-not-allowed border-neutral-800 bg-neutral-900 text-neutral-500"
                : hasRecalculated
                  ? "border-emerald-700 hover:bg-emerald-900/20 text-emerald-300"
                  : "border-neutral-800 hover:bg-neutral-900 hover:border-red-700 hover:bg-red-900/20 hover:text-red-300"
            }`}
            title={
              applyDisabled 
                ? (smallerThanCurrent ? "Размер меньше текущего (есть материалы)" : "Размер вне допустимого диапазона")
                : hasRecalculated
                  ? "Применить размер холста"
                  : "Пересчитать значения"
            }
          >
            {hasRecalculated ? "Apply" : "Recalc"}
          </button>

          {/* divider */}
          <div className="mx-2 h-6 w-px bg-neutral-800" />

          {/* Paste buttons перенесены сюда */}
          <button onClick={pasteLinkFromClipboard} className="px-3 h-8 rounded-md border border-neutral-800 hover:bg-neutral-900 text-xs">
            Paste Link
          </button>
          <button onClick={pasteImageFromClipboard} className="px-3 h-8 rounded-md border border-neutral-800 hover:bg-neutral-900 text-xs">
            Paste Image
          </button>
        </div>

        {/* правая группа: Collect/Shuffle + divider + Zoom/Reset */}
        <div className="ml-auto flex items-center gap-2">
          {board === 'styleboard' ? (
            <button
              onClick={() => runHeavy('collect', collectFill)}
              disabled={heavyBusy || heavyCooldown}
              className={`px-3 h-8 rounded-md border text-xs ${
                heavyBusy || heavyCooldown
                  ? "opacity-50 cursor-not-allowed border-neutral-800 bg-neutral-900 text-neutral-500"
                  : "border-emerald-700/50 text-emerald-300 hover:bg-neutral-900"
              }`}
            >
              {heavyBusy ? "Collect…" : "Collect"}
            </button>
          ) : (
              <button
              onClick={() => runHeavy('shuffle', () =>
                setItemsUndo(prev =>
                  shuffleMoodboard(prev, WRef.current, HRef.current, moodShuffleIntensity)
                )
              )}
                disabled={heavyBusy || heavyCooldown}
                className={`px-3 h-8 rounded-md border text-xs ${
                  heavyBusy || heavyCooldown
                    ? "opacity-50 cursor-not-allowed border-neutral-800 bg-neutral-900 text-neutral-500"
                    : "border-emerald-700/50 text-emerald-300 hover:bg-neutral-900"
                }`}
              >
                {heavyBusy ? "Shuffle…" : "Shuffle"}
              </button>
          )}
          
          {board === 'moodboard' && (
            <div className="ml-2 flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs">
                <span className="text-neutral-400">Intensity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={moodShuffleIntensity}
                  onChange={(e)=> setMoodShuffleIntensity(Number(e.target.value))}
                  className="accent-emerald-500"
                  title="Чем выше — тем больше разнообразие и меньше привязка к оригинальным аспектам"
                />
                <span className="w-6 text-right tabular-nums">{moodShuffleIntensity}</span>
              </label>
            </div>
          )}

          {/* divider перед зумом */}
          <div className="h-6 w-px bg-neutral-800" />

          {/* Zoom/Reset */}
          <div className="flex items-center gap-1">
            <button onClick={() => zoomAt(1/1.1)} className="w-8 h-8 rounded-md border border-neutral-800 hover:bg-neutral-900">−</button>
          <div className="px-2 text-sm tabular-nums w-14 text-center">{Math.round(scale*100)}%</div>
            <button onClick={() => zoomAt(1.1)} className="w-8 h-8 rounded-md border border-neutral-800 hover:bg-neutral-900">+</button>
            <button onClick={() => { setCam({ scale: 1, tx: 0, ty: 0 }); setShouldCenter(true); }} className="ml-2 px-2 h-8 rounded-md border border-neutral-800 hover:bg-neutral-900 text-xs">Reset</button>

            {/* divider слева как у zoom */}
            <div className="h-6 w-px bg-neutral-800 mx-2" />

            <button
              onClick={async () => {
                const p = prompt('Database password:') || '';
                if (!p) return;

                passRef.current = p;
                sessionStorage.setItem('sb:pass', p);
                remoteReadyRef.current = true;

                // апгрейд idb:// → data:
                const upgraded = await upgradeIdbUrls(itemsRef.current);
                if (upgraded !== itemsRef.current) {
                  setItems(upgraded);
                  itemsRef.current = upgraded; // критично: обновили ref вручную, не ждём следующего тика
                }

                try {
                  await flushToCloudNow(p);     // шлём уже по актуальному ref
                  alert('Синхронизировано в БД');
                } catch (e:any) {
                  alert('Ошибка синхронизации в БД: ' + (e?.message || e));
                }
              }}
              className="px-3 h-8 rounded-md text-xs border border-neutral-200 bg-neutral-200 text-neutral-900 hover:bg-white"
              title="Сохранить текущее состояние в БД (пароль обязателен)"
            >
              Write to DB
            </button>
          </div>
        </div>
      </div>

      {/* Progress bar under topbar */}
      {heavyBusy && (
        <div className="fixed top-[52px] left-0 right-0 z-40 h-2">
          <div className="h-full sb-progress" />
        </div>
      )}

      {/* Canvas */}
      <div ref={containerRef} className="absolute inset-0 pt-[52px] overflow-hidden touch-none">
        <div
          className="relative overflow-hidden will-change-transform bg-neutral-950"
          style={{
            width: canvasW,
            height: canvasH,
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "0 0",
            isolation: 'isolate' // свой стек для надёжного z-index
          }}
        >
          {/* Подсказка на артборде */}
          {items.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="text-neutral-500 text-sm md:text-base">
                {board==='moodboard'
                  ? <>Нажмите <span className="px-1 rounded bg-neutral-800 text-neutral-200">Ctrl/Cmd + V</span> — вставьте картинку, ссылку на неё или прямую ссылку на HTML5-видео</>
                  : <>Нажмите <span className="px-1 rounded bg-neutral-800 text-neutral-200">Ctrl/Cmd + V</span> — вставьте картинку или прямую ссылку на сайт / картинку / HTML5-видео</>
                }
              </div>
            </div>
          )}

          {items.map((it) => (
            <Tile 
              key={it.id} 
              item={it} 
              scale={scale} 
              spaceHeld={spaceHeld} 
              ctrlHeld={ctrlHeld} 
              isMoodboard={board==='moodboard'}
            onDelete={(id)=>setItemsUndo(arr=>{ 
              const next = arr.filter(i=>i.id!==id); 
              return boardRef.current==='moodboard' ? reflowMoodboard(next, WRef.current, HRef.current, moodShuffleIntensity) : next; 
            })}
              onApprove={(id)=>setItemsUndo(arr=>arr.map(i=>i.id===id?{...i, approved: !i.approved}:i))} 
              // ↓↓↓ НОВОЕ
              onEdgeDragStart={onEdgeDragStart}
              onEdgeDrag={onEdgeDrag}
              onEdgeDragEnd={onEdgeDragEnd}
            />
          ))}
        </div>

        <div className="pointer-events-none fixed bottom-3 left-1/2 -translate-x-1/2 text-xs text-neutral-400 bg-neutral-900/70 px-2.5 py-1 rounded-full border border-neutral-800">
          <span className="px-1 rounded bg-neutral-800 text-neutral-200">Space</span> и тяни — панорамирование  • <span className="px-1 rounded bg-neutral-800 text-neutral-200">Ctrl/Cmd</span> + колесо — Зум
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`
            fixed bottom-4 right-4 z-[100] px-3.5 py-2 text-sm rounded-md border shadow-lg
            ${toast.kind==='ok'
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-600/40'
              : 'bg-red-500/15 text-red-300 border-red-600/40'}
          `}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}


function Tile({
  item, onDelete, onApprove, scale, spaceHeld, ctrlHeld, isMoodboard,
  onEdgeDragStart, onEdgeDrag, onEdgeDragEnd
}: {
  item: SBItem;
  onDelete: (id:string)=>void;
  onApprove: (id:string)=>void;
  scale: number;
  spaceHeld: boolean;
  ctrlHeld: boolean;
  isMoodboard: boolean;
  onEdgeDragStart: ()=>void;
  onEdgeDrag: (id:string, edge:Dir, delta:number)=>number; // вернёт применённый delta
  onEdgeDragEnd: ()=>void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [iframeActive, setIframeActive] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const scrollKey = `sb:iframeScroll:${item.url}`;

  useEffect(() => {
    let canceled = false;
    let created: string | null = null;
    (async () => {
      if (item.kind === 'image' && isIdbUrl(item.url)) {
        const blob = await idbGetBlob(idFromIdbUrl(item.url));
        if (!blob) return;
        created = URL.createObjectURL(blob);
        if (!canceled) setResolvedSrc(created);
        // Добавляем натуральные размеры для изображений из IndexedDB
        if (!item.natW && !item.natH) {
          assignNatSizeToItem(item, blob);
        }
      } else {
        setResolvedSrc(item.url);
      }
    })();
    return () => {
      canceled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [item.url, item.kind]);

  function tryAttachScrollHandlers() {
    const frame = iframeRef.current;
    if (!frame) return () => {};

    let win: Window | null = null;
    let onScroll: ((e: Event) => void) | null = null;

    // 1) Проверяем same-origin простым пробным доступом к document
    try {
      win = frame.contentWindow!;
      // если к document доступа нет — бросит, уйдем в catch
      void win.document;
    } catch {
      // cross-origin — ничего не вешаем, чтобы не падать потом на cleanup
      return () => {};
    }

    // 2) Вешаем слушатель и сохраняем позицию
    onScroll = () => {
      try {
        const pos = { x: win!.pageXOffset || 0, y: win!.pageYOffset || 0 };
        localStorage.setItem(scrollKey, JSON.stringify(pos));
      } catch {
        /* игнор */
      }
    };

    try {
      win.addEventListener("scroll", onScroll, { passive: true });
      // восстановление скролла
      const raw = localStorage.getItem(scrollKey);
      if (raw) {
        const { x = 0, y = 0 } = JSON.parse(raw);
        win.scrollTo(x, y);
      }
    } catch {
      /* если addEventListener внезапно упал — просто молча уходим */
    }

    // 3) Безопасный detach — внутри try/catch
    return () => {
      try {
        if (win && onScroll) win.removeEventListener("scroll", onScroll);
      } catch {
        /* игнор — на случай, если origin сменился */
      }
    };
  }

  useEffect(() => {
    // пробуем при загрузке фрейма и при активации
    const detach = tryAttachScrollHandlers();
    return detach;
  }, [item.url, iframeActive]);

  // деактивация при клике вне и по Esc
  useEffect(() => {
    const offClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setIframeActive(false);
    };
    const offEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIframeActive(false);
    };
    window.addEventListener("mousedown", offClick, true);
    window.addEventListener("keydown", offEsc);
    return () => {
      window.removeEventListener("mousedown", offClick, true);
      window.removeEventListener("keydown", offEsc);
    };
  }, []);

  // подтверждение удаления
  async function handleDelete() {
    if (window.confirm("Удалить материал?")) {
      await maybeDeleteIdb(item.url);
      onDelete(item.id);
    }
  }

  const left = item.gx * GRID;
  const top = item.gy * GRID;
  const width  = item.gw * GRID;
  const height = item.gh * GRID;

  useEffect(() => {
    if (!LOG.tileRender) return;
    console.log('[Tile]', {
      id: item.id.slice(-4), kind: item.kind,
      gx: item.gx, gy: item.gy, gw: item.gw, gh: item.gh,
      left, top, width, height
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startEdgeDrag(edge: Dir, e: React.MouseEvent) {
    if (!isMoodboard) return;
    e.preventDefault();
    e.stopPropagation();

    onEdgeDragStart();

    const startX = e.clientX;
    const startY = e.clientY;
    let applied = 0; // уже применённые «клетки»

    const onMove = (ev: MouseEvent) => {
      const dxCells = Math.round((ev.clientX - startX) / (GRID * scale));
      const dyCells = Math.round((ev.clientY - startY) / (GRID * scale));
      let want = 0;
      if (edge === 'left' || edge === 'right') want = dxCells - applied;
      else want = dyCells - applied;

      if (!want) return;
      // попросим применить; получим фактически применённый инкремент
      const got = onEdgeDrag(item.id, edge, want);
      if (got) applied += got;
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onEdgeDragEnd();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div 
      ref={rootRef}
      onDoubleClick={() => { if (item.kind === "site") setIframeActive(v => !v); }}
      style={{ left, top, width, height }}
      className={
        "group absolute overflow-hidden " +
        (isMoodboard
          ? "bg-black"
          : "rounded-xl border border-neutral-800 bg-neutral-900 shadow-lg " +
            (item.approved ? "ring-4 ring-emerald-500" : ""))
      }
    >
      {/* HUD: показывать только на hover, фиксированный размер (инверсный scale) */}
      <div
        className="pointer-events-none absolute top-2 left-2 right-2 z-10 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ transform: `scale(${1/scale})`, transformOrigin: 'top right' }}
      >
        <div className="pointer-events-auto flex items-center gap-1 px-1.5 py-1 rounded-md bg-neutral-950/70 backdrop-blur border border-neutral-800">
          {/* copy link icon */}
          <button
            onClick={() => navigator.clipboard.writeText(item.url)}
            title="Скопировать ссылку"
            className="p-1 rounded hover:bg-neutral-800"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11a4 4 0 0 1 0-6l1-1a4 4 0 0 1 6 6l-1 1" />
              <path d="M15 13a4 4 0 0 1 0 6l-1 1a4 4 0 0 1-6-6l1-1" />
            </svg>
          </button>
          {/* approve toggle (check) — теперь и для moodboard */}
          <button
            onClick={() => onApprove(item.id)}
            title={item.approved ? "Unapprove" : "Approve"}
            className={`p-1 rounded hover:bg-neutral-800 ${item.approved ? "text-emerald-400" : ""}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </button>
          {/* delete (trash) */}
          <button
            onClick={handleDelete}
            title="Удалить"
            className="p-1 rounded hover:bg-neutral-800 text-red-400"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      {!isMoodboard && item.approved && (
        <div className="absolute -left-8 top-4 -rotate-45 bg-emerald-500 text-emerald-950 text-[10px] font-bold px-8 py-1 shadow z-20">APPROVED</div>
      )}

      {/* Внутренняя зелёная обводка для moodboard */}
      {isMoodboard && item.approved && (
        <div className="absolute inset-0 pointer-events-none z-[5]"
             style={{ boxShadow: 'inset 0 0 0 4px rgba(16,185,129,1)' }} />
      )}

      <div className="w-full h-full relative">
        {!loaded && <Skeleton />}
        <div className={`${loaded?"opacity-100":"opacity-0"} transition-opacity duration-300 w-full h-full`}>
          {item.kind === "image" ? (
            <img
              src={resolvedSrc || ''}
              alt=""
              className="w-full h-full object-cover bg-black"
              decoding="async"
              loading="lazy"
              onLoad={()=>setLoaded(true)}
              onError={()=>setLoaded(true)}
            />
          ) : item.kind === "video" ? (
            <video
              src={item.url}
              className="w-full h-full object-cover bg-black"
              muted
              loop
              playsInline
              autoPlay
              // без controls — чтобы вёл себя как img
              onLoadedMetadata={()=>setLoaded(true)}
              onError={()=>setLoaded(true)}
            />
          ) : (
            <div className="absolute inset-x-0 top-[4px] bottom-[4px]">
              <iframe
                ref={iframeRef}
                src={item.url}
                title={item.url}
                loading="lazy"
                className="w-full h-full bg-black"
                style={{
                  pointerEvents: (iframeActive && !spaceHeld && !ctrlHeld) ? 'auto' : 'none'
                }}
                onLoad={() => {
                  setLoaded(true);
                  tryAttachScrollHandlers(); // восстановим скролл, если возможно
                }}
              />
              {/* Подсказка поверх, когда iframe неактивен или заблокирован панорамой/зумом */}
              {(!iframeActive || spaceHeld || ctrlHeld) && (
                <div className="absolute bottom-1 left-1 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="px-3 py-1.5 text-xs rounded-md bg-neutral-950/70 border border-neutral-800 text-neutral-200">
                    Двойной клик, чтобы активировать сайт во фрейме
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Хэндлы для перетаскивания рёбер (только для Moodboard) */}
      {isMoodboard && (
        <>
          {/* вертикальные */}
          <div
            className="absolute inset-y-0 -left-1 w-2 cursor-ew-resize z-20"
            onMouseDown={(e)=>startEdgeDrag('left', e)}
          />
          <div
            className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize z-20"
            onMouseDown={(e)=>startEdgeDrag('right', e)}
          />
          {/* горизонтальные */}
          <div
            className="absolute inset-x-0 -top-1 h-2 cursor-ns-resize z-20"
            onMouseDown={(e)=>startEdgeDrag('up', e)}
          />
          <div
            className="absolute inset-x-0 -bottom-1 h-2 cursor-ns-resize z-20"
            onMouseDown={(e)=>startEdgeDrag('down', e)}
          />
        </>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="absolute inset-0 bg-neutral-900 animate-pulse grid place-items-center">
      <div className="w-24 h-24 rounded-full border-4 border-neutral-800 border-t-neutral-600 animate-spin" />
    </div>
  );
}

function detectDesktop(): boolean {
  const ua = navigator.userAgent;
  const isTouch = matchMedia("(hover: none), (pointer: coarse)").matches || "ontouchstart" in window;
  const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|IEMobile|BB10|PlayBook|Silk/i.test(ua);
  const minViewport = Math.min(window.innerWidth, window.innerHeight);
  return !isTouch && !isMobileUA && minViewport >= 900; // простое, но жёсткое правило
}

function detectChrome(): boolean {
  const ua = navigator.userAgent;
  return /Chrome/.test(ua) && !/Edg|OPR|Opera/.test(ua);
}

function showSystemNotification(message: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Styleboard', { body: message, icon: '/favicon.ico' });
  } else if ('Notification' in window && Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        new Notification('Styleboard', { body: message, icon: '/favicon.ico' });
      }
    });
  }
}

export default function App() {
  const [allowed, setAllowed] = useState<boolean>(() => detectDesktop());

  useEffect(() => {
    const onResize = () => setAllowed(detectDesktop());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Проверка Chrome и показ системного уведомления
  useEffect(() => {
    if (allowed && !detectChrome()) {
      showSystemNotification('Приложение протестировано только в Chrome. Возможны сбои в других браузерах.');
    }
  }, [allowed]);

  if (!allowed) {
    return (
      <div className="h-screen w-screen bg-neutral-950 text-neutral-200 grid place-items-center">
        <div className="px-4 py-3 rounded-lg border border-neutral-800 bg-neutral-900 shadow">
          <div className="text-lg font-semibold mb-1">Desktop only</div>
          <div className="text-sm text-neutral-400">
            Это приложение поддерживает только десктопные браузеры. Откройте на компьютере.
          </div>
        </div>
      </div>
    );
  }
  return <AppInner />;
}


