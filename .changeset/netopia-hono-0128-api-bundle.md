---
"@voyant-travel/plugin-netopia": patch
---

Rebuild against the framework 0.48 package set. hono 0.128 completed the Api\* rename, so the plugin now imports `defineApiBundle`/`ApiBundle`/`ApiExtension` (was `defineHonoBundle`/`HonoBundle`/`HonoExtension`, removed by hono 0.128) and bumps `@voyant-travel/hono` to ^0.128.1 alongside the coherent core ^0.125.0, utils ^0.107.1, finance ^0.164.0, and notifications ^0.130.4 lines. This unblocks loading the plugin under the 0.48 upgrade without a consumer-side pnpm patch.
