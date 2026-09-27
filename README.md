# Floway PR #528 Screenshots

Production Web build at `2f7a03844562a3727b9188110382f7107d083a91`, rendered with synthetic API responses. No real reset card was consumed.

These review artifacts belong to https://github.com/Menci/Floway/pull/528 and are kept outside the product branch.

Screenshots cover the available action, confirmation, pending redemption, success with a disabled Redeemed button, empty list, list failure, redemption failure, expiry, dark theme, a 390px Simplified Chinese viewport, and a 320px English viewport.

`pnpm run verify` passed: 587 test files, 6,325 tests, 63 installer checks passed and 47 host-dependent skips. Type generation, lint, typechecks, repository invariant checks, and production Web build passed.

Browser checks: title and action centers and expiry right edges differ by zero CSS pixels at desktop, 390px Chinese, and 320px English widths. Cancellation sent zero consume requests; success sent one; three retry attempts shared one idempotency key; redeemed action disabled; no page errors, unexpected requests, or mobile horizontal overflow.

![Available card](01-available-light.png)
![Redeemed card](04-success.png)
![Empty list](05-empty.png)
![Chinese mobile](10-mobile-chinese.png)
![Narrow English layout](11-compact-english.png)
