# Slice 5 Real Platform Adapters Design

**Status:** Implemented; simulated verification complete, live smoke remains account-dependent
**Scope:** Douyin and WeChat Channels publishing adapters behind the existing Publisher Worker boundary.

## Goal

Add the first two real-platform adapters without weakening ContentOS's Publisher contract, credential boundary, human-review gate or reconciliation rules:

- Douyin uses the official OpenAPI upload/create flow.
- WeChat Channels uses an isolated Playwright session against the Channels Assistant web UI because no comparable public publishing OpenAPI was found.

No platform credentials, cookies, browser profiles or live account artifacts enter the repository.

## Evidence and GitHub assessment

- The official Douyin documentation defines video upload and create-video operations, OAuth access tokens, upload size/duration limits and a review period after creation. The implementation will pin endpoint paths and error mappings in a platform profile rather than scatter them through business code.
- `dreammis/social-auto-upload`, `jefftko/PostFlow` and `meeno2020/wxvideo` demonstrate the practical Playwright pattern for account profiles, manual login, selector templates, screenshots and resumable batches. They are reference implementations, not dependencies of ContentOS.
- `eahau/douyin-openapi` and `xopenapi/douyin-open-api-go` demonstrate generated clients from Douyin OpenAPI descriptions. ContentOS will keep a small injected HTTP client instead of importing a generated Java/Go client into the TypeScript monorepo.
- `liuxuehao/weixinshipinhao_publisher` explicitly identifies its Channels Assistant HTTP calls as unofficial. `nobiyou/wx_channel` uses proxy/certificate injection. Neither approach is accepted as a ContentOS dependency.

## Architecture

### Shared Publisher boundary

Extend the existing contract without breaking Fake Publisher:

```ts
type PublisherCredential = {
  accessToken?: string;
  refreshToken?: string;
  clientKey?: string;
  clientSecret?: string;
  openId?: string;
};

type PublisherContext = {
  profileDir: string;
  credentialRef: string;
  credential?: PublisherCredential;
};

type PublishSnapshot = {
  requestId: string;
  idempotencyKey: string;
  assetId: string;
  mediaPath?: string;
  coverPath?: string;
  title: string;
  description: string;
};
```

The Worker resolves a credential reference into memory and passes it to the adapter. The adapter result never returns credential material. Redaction remains mandatory for structured logs and errors.

Add a `PublisherAdapterRegistry` keyed by stable platform IDs (`douyin`, `wechat-channels`). Registration is explicit in the Publisher Worker composition root; adding a third platform does not change existing adapters.

### Douyin adapter

Create `DouyinOpenApiAdapter` with injected `fetch`/HTTP transport and endpoint profile. Its flow is:

1. Validate an access token, `openId`, local media path and supported media metadata.
2. Upload the video through the official upload endpoint; use streamed multipart for small files and the documented part-upload flow for large files.
3. Create the video with title/description and returned encrypted `video_id`.
4. Return the external item ID and a deterministic platform status.
5. Reconcile by querying the published item/list endpoint when the create response is uncertain.

HTTP status and platform error codes map only to the existing taxonomy: `AUTH_EXPIRED`, `REQUIRES_VERIFICATION`, `RATE_LIMIT`, `UPLOAD_FAILED`, `NETWORK_ERROR`, `UNKNOWN_EXTERNAL_STATE` and `PLATFORM_CHANGED` where applicable.

### WeChat Channels adapter

Create `WeChatChannelsPlaywrightAdapter` with an injected `BrowserSessionFactory` and selector profile. The Worker owns the persistent browser context and profile directory; the adapter owns only page-level publishing steps:

1. Open the Channels Assistant publish page in the account's isolated profile.
2. Detect login/verification state before uploading.
3. Upload `mediaPath`, fill description and optional cover, and stop before irreversible submission when human confirmation is required.
4. Submit only when the request carries an approved Review decision and the configured confirmation policy allows it.
5. Detect a stable success marker or return `UNKNOWN_EXTERNAL_STATE`; save a redacted screenshot/evidence reference on failure.

Selectors are centralized in a versioned profile. No network interception, private endpoint replay, CAPTCHA bypass, cookie extraction or `navigator.webdriver` masking is allowed.

## Credential and safety rules

- Add a `CredentialProvider` port; local development may use environment-backed values, while production remains vault/secure-store compatible.
- Credential refs, raw access tokens, cookies and client secrets are never persisted in Job payloads, database rows, screenshots or logs.
- Profiles are per account and per platform. A browser crash closes the context and returns `UNKNOWN_EXTERNAL_STATE` until reconcile confirms the result.
- Verification, login and approval actions are human-in-the-loop. The worker must not type OTPs, bypass challenges or silently publish an unapproved request.
- Real smoke tests are opt-in, platform-specific and excluded from CI unless all required environment variables are present.

## Tests and acceptance

Automated tests will use injected fake HTTP and browser ports:

- Contract tests for both adapters' capabilities, required credential/media validation, idempotency and normalized failures.
- Douyin HTTP tests for multipart upload, create payload, OAuth failure, rate limit, network failure and uncertain response reconciliation.
- WeChat browser tests for profile isolation, selector flow, login expiry, verification, DOM drift, human-confirmation stop and uncertain result.
- Worker tests for platform registry dispatch, Review approval gating, graceful shutdown and redacted diagnostics.
- No live account is required for the normal 41-test suite; a separate documented smoke command is the only path to real publishing.

The slice is accepted when format, lint, typecheck, full tests, build and doctor pass, the adapters are registered behind the Publisher Worker, and the repository contains no credentials or platform-specific private endpoint code.

## Alternatives considered

1. **Both platforms through Playwright:** easiest shared implementation, but unnecessary for Douyin and exposes both platforms to DOM churn. Rejected as the default.
2. **Both platforms through official APIs:** cleanest architecture, but blocked for ordinary WeChat Channels publishing because no public official publish API was identified. Deferred unless Tencent grants an authorized interface.
3. **Hybrid official Douyin API + Channels Playwright:** recommended; it minimizes DOM dependence while preserving a viable path for video号 and keeps both implementations behind one adapter contract.
