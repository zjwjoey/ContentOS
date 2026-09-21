# Jianying draft runtime

ContentOS imports plaintext Jianying JSON drafts directly. Plain drafts do not need any extra runtime and remain supported when the encrypted runtime is unavailable.

## Encrypted drafts

Newer Jianying versions may encrypt `draft_content.json`. Reading those drafts requires:

1. Windows x64.
2. A locally installed Jianying version whose installation contains `videoeditor.dll`.
3. The buildable ContentOS helper from `tools/jianying-draft-helper`.

ContentOS never distributes, downloads, copies, or commits `videoeditor.dll`. The helper loads the user's local DLL only for the duration of a read operation.

Build the helper with:

```powershell
pnpm build:jianying-helper
```

The resulting executable is `tools/jianying-draft-helper/bin/jianying-draft-helper.exe` and is ignored by Git. The helper implementation and protocol are documented in `tools/jianying-draft-helper/README.md`.

## Discovery and configuration

Discovery order is:

1. `JIANYING_DRAFT_HELPER` and `JIANYING_VIDEOEDITOR_DLL`, if they point to real files.
2. The ContentOS helper build output and controlled ContentOS helper install locations.
3. Known Jianying installation roots under `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`, and `APPDATA`, with only direct and one-level version-directory checks for `videoeditor.dll`.

Optional configuration:

```dotenv
JIANYING_VIDEOEDITOR_DLL=C:\\Program Files\\JianyingPro\\<version>\\videoeditor.dll
JIANYING_DRAFT_HELPER=C:\\path\\to\\jianying-draft-helper.exe
```

The runtime diagnostics endpoint is `GET /api/v1/edit/v3/jianying/runtime`. It reports platform, configured/available flags, safe basenames, and one of `READY`, `HELPER_MISSING`, `DLL_MISSING`, or `UNSUPPORTED_PLATFORM`; it never returns API secrets or full local paths to the browser.

## Verification

```powershell
pnpm test:jianying-runtime -- "C:\\path\\to\\draft"
```

The smoke test is read-only, uses the same Composite adapter as the application, and prints only draft id/name plus material, track, and segment counts. It prints `Jianying runtime smoke test: PASS` on success, `BLOCKED_BY_ENVIRONMENT` when Windows/Jianying/helper/DLL are unavailable, and `FAIL` for a real runtime/decryption error.

Common errors:

- `JIANYING_VIDEOEDITOR_DLL_UNAVAILABLE`
- `JIANYING_HELPER_UNAVAILABLE`
- `JIANYING_UNSUPPORTED_DRAFT_VERSION`
- `JIANYING_ENCRYPTED_DRAFT_REQUIRES_WINDOWS_RUNTIME`
- `JIANYING_HELPER_TIMEOUT`
- `JIANYING_HELPER_PROTOCOL_MISMATCH`

ContentOS always copies input metadata into an owned temporary directory, validates helper output paths and protocol version, and removes the entire temporary tree in `finally`. The original Jianying draft is never modified.

The helper ABI boundary is informed by the MIT-licensed `jy-draftc` project, whose public documentation identifies the verified `EncryptUtils::decrypt` export. ContentOS does not vendor its executable or the proprietary Jianying DLL. See `tools/jianying-draft-helper/THIRD_PARTY_NOTICES.md`.
