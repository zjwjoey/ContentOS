# Spike 03: Asset staging and atomic promotion

Disposable verification code for the V0 asset boundary. It uses a local filesystem only: stage into `.part` files, verify SHA-256, promote to a content-addressed object path with atomic rename, retain Unicode metadata and remove stale crash-window files. It is not a production storage module.

```powershell
npm test
npm run run
```

No cloud bucket, external account or ContentOS product directory is used.
