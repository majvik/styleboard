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

Если будет ругаться — убедись, что у тебя Node 18+ (`node -v`). При необходимости: `rm -rf node_modules package-lock.json && npm install`.
