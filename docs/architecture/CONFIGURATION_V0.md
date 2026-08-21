# Configuration V0

## Configuration classes

| Class | Examples | Source and change policy |
|---|---|---|
| Boot configuration | database URL, storage root, worker concurrency, log level | environment/config file; restart required |
| Secret references | provider key, platform session, encryption key | environment or secret store; values never persisted/logged |
| Dynamic configuration | enabled provider/model, platform capabilities, retention policy | PostgreSQL configuration record; audited revision |
| Project policy | destination defaults, review thresholds | Project-scoped revision; explicit effective date |

Configuration precedence is: safe built-in default, checked-in non-secret environment template, deployment environment variables, then authorized dynamic configuration where the setting is designed to be dynamic. A dynamic setting cannot override boot security boundaries such as database host or secret store.

## Required profiles

`development`, `test`, `staging`, and `production` are explicit profiles. V0 development supports local filesystem storage and local PostgreSQL only through the same storage/queue ports used elsewhere. Tests must use isolated temporary storage roots and databases.

## Secrets and configuration snapshots

Only opaque `CredentialRef` values may enter persistent records. Config-dependent Jobs record an effective non-secret configuration version/hash so an operator can explain behavior later. Rotating a credential does not rewrite historical jobs; retries resolve the current referenced secret under policy.

Startup validates configuration and fails closed for missing required values. Feature capability is disabled with an explicit status if an optional provider/platform profile is absent. Logging must redact known secret keys, URLs with credentials, cookies and authorization headers.
