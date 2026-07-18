---
"@voyant-travel/netopia-adapter": minor
---

Rename `@voyant-travel/plugin-netopia` to `@voyant-travel/netopia-adapter` and reclassify it as a deployment **adapter** (`kind: "adapter"`, `voyant.adapter.v1`) rather than a plugin, matching the RFC #3395 taxonomy and the `<vendor>-adapter` convention (cf. `@voyant-travel/algolia-adapter`). Also implements the canonical payments adapter runtime contract and requires signed Netopia callback verification.
