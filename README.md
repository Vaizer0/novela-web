# NoveLA Web

A fully functional web port of the [NoveLA Android app](https://github.com/Hndk0/NoveLA) — read novels and manga online with extension support, accurate TTS word highlighting, translation, and offline-first PWA support.

## Live Site

Deployed to GitHub Pages automatically on every push to main.

## Features

- **Multi-source extension plugin system** — install JS extensions to browse and fetch books from any source
- **IndexedDB persistence** — all library data, chapters, history and settings stored locally
- **Accurate TTS word-boundary highlighting** — uses SpeechSynthesis boundary events for real-time, drift-free word highlighting
- **Multi-language translation** — Google (free), Gemini, OpenAI/custom
- **20+ themes** — dark, light, catppuccin, nord, matrix, doom, and more
- **EPUB / FB2 import** — import local files directly into your library
- **Reading history, library management, manga reader** — full feature parity with the Android app
- **Interactive cinematic background** — animated starfield + asteroid mini-game (click asteroids to destroy them)
- **PWA / installable** — add to home screen for offline use
- **Fully responsive** — works on mobile, tablet, and desktop

## Development

```bash
# Serve locally (IndexedDB requires a proper origin)
python3 -m http.server 8080
# or use VS Code Live Server
```

## Extensions

Go to the Extensions tab to install extensions via URL or browse the built-in index.
Extensions are JavaScript modules that implement: `fetchPopular`, `fetchLatest`, `fetchChapterList`, `getBookInfo`, `search`.

## Deployment

Push to the `main` branch — GitHub Actions automatically deploys to GitHub Pages.

## License

MIT
