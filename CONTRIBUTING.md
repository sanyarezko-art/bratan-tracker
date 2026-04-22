# Contributing

## Локальная разработка десктоп-клиента

```bash
cd desktop
npm install
npm start
```

Приложение откроется с горячей перезагрузкой только при ручном рестарте —
специально без webpack/vite, чтобы держать сборку простой.

Структура:

- `desktop/main.js` — main process, WebTorrent-клиент и IPC-хэндлеры.
- `desktop/preload.js` — `contextBridge`, единственный канал в renderer.
- `desktop/renderer/` — UI (HTML/CSS/JS без фреймворков).
- `desktop/assets/` — иконка, статика для упаковки.
- `desktop/package.json` — `build.*` секция конфигурирует electron-builder.

## Принципы

- Никакой телеметрии, аналитики, сторонних шрифтов, сторонних картинок.
- Никаких сетевых вызовов к нашим / чужим бэкендам. Только BitTorrent-трафик.
- Renderer всегда sandbox + contextIsolation. Node-доступ — только через
  `preload.js` с узким API.
- Лендинг `index.html` — чистый HTML/CSS + один маленький inline-скрипт для
  детекта OS. Никаких внешних зависимостей.

## Релиз

Сборки автоматически делает `.github/workflows/release.yml` на каждый
push тега `v*`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Артефакты (Windows NSIS + portable, macOS DMG × (Intel + ARM),
Linux AppImage) попадают в GitHub Release вместе с `SHA256SUMS.txt`.
