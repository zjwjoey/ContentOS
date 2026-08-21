# Spike 04: Publisher Worker and Playwright-style isolation

Disposable local verification code. `FakePlatform` exposes a small Playwright-shaped browser/page interface so worker behavior can be tested without a real platform, account, credential or network. Each profile gets its own context and profile directory; browser and worker failures are structured; logs redact secrets.

```powershell
npm test
npm run run
```

This spike deliberately does not install or launch a real browser and does not access any publishing platform.
