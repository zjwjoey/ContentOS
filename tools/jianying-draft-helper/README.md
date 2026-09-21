# ContentOS Jianying Draft Helper

This is the buildable Windows helper used by ContentOS for encrypted Jianying drafts. It loads the user's installed `videoeditor.dll` at runtime; the DLL is never bundled, copied, downloaded, or committed by ContentOS.

## Build

From the repository root:

```powershell
pnpm build:jianying-helper
```

The command writes `tools/jianying-draft-helper/bin/jianying-draft-helper.exe`. The helper is intentionally ignored by Git. A Windows machine needs MinGW-w64 `g++` or a Visual Studio Developer PowerShell with `cl.exe`.

## Protocol

```text
jianying-draft-helper.exe --input <file-or-directory> --output <ContentOS-temp-directory> --dll <path-to-videoeditor.dll>
jianying-draft-helper.exe --version
```

The helper writes only machine-readable JSON to stdout. Human diagnostics go to stderr.

Success:

```json
{"status":"ok","protocolVersion":1,"files":["draft_content.json"]}
```

Failure uses `status: "error"`, `protocolVersion: 1`, a stable `code`, and a human-readable `message`, then exits non-zero.

The ABI boundary is isolated in this process. The current implementation is based on the public `jy-draftc` documentation/source and its MIT-licensed, verified `EncryptUtils::decrypt` export shape; ContentOS does not copy or distribute `videoeditor.dll`.
