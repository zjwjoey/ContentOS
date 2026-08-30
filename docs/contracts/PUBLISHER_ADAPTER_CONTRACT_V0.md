# Publisher Adapter Contract V0

## Boundary

The Publisher Worker owns browser/context lifecycle. A platform adapter owns selectors, navigation and platform-specific capabilities. Publisher domain code sees normalized outcomes, never DOM selectors or SDK objects.

## Operations

```text
capabilities() -> PlatformCapabilityProfile
authenticate(context, credentialRef) -> AuthResult
publish(context, PublishSnapshot) -> PublishResult
reconcile(context, idempotencyKey) -> ExternalStateResult
```

## Canonical outcome taxonomy

| Code | Classification | Default action |
|---|---|---|
| `AUTH_EXPIRED` | Human action required | Block and request re-authentication |
| `REQUIRES_VERIFICATION` | Human action required | Block; do not retry blindly |
| `PLATFORM_CHANGED` | Permanent until adapter update | Stop and surface diagnostics |
| `RATE_LIMIT` | Retryable | Backoff according to platform policy |
| `UPLOAD_FAILED` | Retryable or terminal by detail | Retry only when the adapter classifies it transient |
| `NETWORK_ERROR` | Retryable | Retry with bounded backoff |
| `UNKNOWN_EXTERNAL_STATE` | Reconciliation required | Query platform before any retry |
| `UNKNOWN` | Terminal pending review | Preserve evidence and require operator action |

Browser/worker crashes are mapped to `UNKNOWN_EXTERNAL_STATE` when a side effect may have happened, and to a safe retryable infrastructure failure only when the adapter proves no external action occurred. The Spike codes `AUTH_REQUIRED`, `VERIFICATION_REQUIRED`, `DOM_CHANGED` and `BROWSER_CRASH` normalize to this taxonomy.

## Security and isolation

One browser context and profile directory per account/environment. Credentials, cookies, authorization headers, private URLs and tokens never enter ordinary logs or Job payloads. Failure evidence is redacted and access-controlled.

## Integration Closure additions

The current contract accepts `fake-platform`, `douyin` and `wechat-channels`. A publish snapshot may carry immutable media paths and SHA-256 fields; `createPublishSnapshotDigest` binds the reviewed account, platform, asset and content fields. Credentials are resolved from an `env://NAME` reference inside the Publisher Worker and exist only in process memory.

`UNKNOWN_EXTERNAL_STATE` always enters reconciliation before another publish attempt. Adapter code is implemented and simulated against fakes; **IMPLEMENTED != LIVE-VERIFIED**. Live verification remains an explicit, separately authorized gate.
