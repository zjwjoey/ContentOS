# Publisher module

The Publisher module now contains:

- a platform-neutral `PublisherAdapter` contract and deterministic Fake Platform;
- `DouyinOpenApiAdapter`, using injected official OpenAPI HTTP transport;
- `WeChatChannelsPlaywrightAdapter`, using a Worker-owned isolated browser profile;
- explicit platform registry, credential-provider and Review approval ports.

Real publishing is not part of the normal test suite. Use `pnpm publisher:smoke` only with
an explicit `CONTENTOS_REAL_PLATFORM_SMOKE=1`, a local credential reference, an approved
Review decision and an intentional human-submit flag. Credentials, cookies and browser
profiles must remain outside Git. The adapters do not use private Channels endpoints,
network interception or CAPTCHA bypass.
