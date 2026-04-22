# БРАТАН

Анонимный P2P-туннель для обмена файлами между компьютерами. Десктоп-приложение
без сервера, без логов, без аккаунтов. Файлы идут **напрямую** от отправителя
получателю поверх полного BitTorrent-стека (TCP / UDP / uTP / DHT / LSD + WebRTC).

**Лендинг со ссылками на скачивание:** <https://sanyarezko-art.github.io/bratan-tracker/>
**Релизы (Windows / macOS / Linux):** <https://github.com/sanyarezko-art/bratan-tracker/releases>

---

## Как это работает для юзера

1. Установил `БРАТАН` на свой ПК (и на ПК того, кому отправляешь).
2. Бросил файл в окно приложения → получил magnet-ссылку.
3. Отправил magnet собеседнику (мессенджер, e-mail — как угодно).
4. Он вставил её в своём БРАТАНе — файл пошёл **напрямую**.

Никакой сервер в середине не держит файлы и не видит, что именно вы передаёте.

## Репозиторий

```
bratan-tracker/
├── index.html                    # лендинг (GitHub Pages)
├── desktop/                      # Electron-приложение
│   ├── main.js                   # main process (WebTorrent + IPC)
│   ├── preload.js                # contextBridge к renderer
│   ├── renderer/                 # UI (HTML/CSS/JS)
│   ├── assets/icon.png           # иконка
│   └── package.json              # electron-builder конфиг
└── .github/workflows/
    ├── pages.yml                 # деплой лендинга
    └── release.yml               # сборка 3-OS инсталляторов по git tag
```

## Разработка (desktop)

Требуется Node.js 20+.

```bash
cd desktop
npm install
npm start                # запустить приложение локально
npm run dist             # собрать инсталлятор для текущей ОС
```

## Релиз

Релиз делается автоматически по push git-тега:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` собирает сборки на Windows / macOS / Linux runner-ах и
выкладывает в GitHub Release вместе с `SHA256SUMS.txt`.

## Почему без подписи кода

Сертификаты Microsoft Authenticode и Apple Developer ID стоят $200–500/год.
Пока приложение небольшое — не покупаем, при первом запуске ОС покажет
«неизвестный издатель». Инструкция как разрешить запуск — на лендинге.
Проверить подлинность скачанного можно по SHA-256 из `SHA256SUMS.txt`.

## Лицензия

[MIT](LICENSE).
