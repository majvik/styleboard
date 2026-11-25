# Website Styleboard — Local (macOS)

Тёмный минималистичный мудборд/стайлборд для локального запуска.

## Что внутри
- React + TypeScript + Vite + Tailwind
- Две доски (moodboard / styleboard), локальное хранилище
- Добавление ссылок на сайт/изображение/видео
- Панорамирование как в Miro: Space + drag
- Зум: кнопки, горячие клавиши (⌘/Ctrl +, −, 0), **колесо/пинч с ⌘/Ctrl**
- Сетка 16px, авторазмещение
- HUD: copy, Approve (лента), Delete
- Iframe сайтов ровно 1440×1080

## Локальный запуск
```bash
npm install
npm run dev
# открой http://localhost:5173
```

## Cloudflare storage setup

The API uses Cloudflare R2 for image/video objects and D1 for board records. It has no Supabase or PostgreSQL runtime fallback. Add these server-side variables to `.env` and Netlify Functions:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` with D1 read/write permissions for the selected database
- `D1_DATABASE_ID`
- `R2_ENDPOINT` (`https://<account-id>.r2.cloudflarestorage.com`)
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (R2 Object Read & Write token scoped to the media bucket)
- `R2_BUCKET`
- `R2_PUBLIC_URL` (the bucket's public custom domain or enabled `r2.dev` URL)
- `WRITE_PASSWORD`

The R2 region defaults to `auto`. `netlify/schema.sql` defines the D1 table; the API also creates it idempotently. Configure bucket CORS for the app origins with `PUT` and `content-type`. R2 public URLs require public bucket access; Cloudflare recommends a custom domain for production and limits `r2.dev` to development. Keep all credentials out of client-side variables.

The prior PostgreSQL/Supabase database and objects are untouched. Before switching the deployment, export the old `sb_items` rows and retain a backup. Import them into the new D1 table using a one-time, non-destructive `INSERT OR IGNORE` migration after configuring Cloudflare credentials; existing object URLs remain in the records and continue to reference their current storage until separately copied to R2. No migration runs automatically and no old remote data is deleted.

Если будет ругаться — убедись, что у тебя Node 18+ (`node -v`). При необходимости: `rm -rf node_modules package-lock.json && npm install`.
