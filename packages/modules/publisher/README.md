# Publisher module

Slice 4 provides a platform-neutral `PublisherAdapter`, a deterministic Fake Platform,
isolated per-account profile directories and normalized failure taxonomy. The module does
not store real credentials or call real platforms. Douyin/WeChat adapters remain deferred
to Slice 5 pending explicit credential, human-confirmation and smoke-test gates.
