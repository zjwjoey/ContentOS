# Playwright infrastructure

Provides the Publisher Worker-owned Playwright session factory used by authorized real
platform adapters. Profiles are passed in explicitly per account/platform, sessions are
closed by `withBrowserSession`, and no cookies or anti-detection patches are persisted by
this package.
