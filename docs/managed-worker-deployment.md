# Managed Netopia Worker deployment

The processor Worker is operated by Voyant and is not installed in an operator deployment. It is
stateless: the managed payments control plane decrypts the selected connection for one request and
sends those credentials to the Worker over the versioned RPC contract.

No Cloudflare resources are provisioned or deployed by the repository. `wrangler.jsonc` defines
isolated staging and production Worker names and uses their `workers.dev` endpoints until Voyant
assigns reviewed custom domains. Preview URLs are disabled.

## Environment contract

| Environment | Worker | Public probes | Control-plane endpoint |
| --- | --- | --- | --- |
| Staging | `voyant-netopia-worker-staging` | `/health`, `/readyz` | deployed Worker URL plus `/rpc` |
| Production | `voyant-netopia-worker` | `/health`, `/readyz` | `https://voyant-netopia-worker.pixelmakers.workers.dev/rpc` |

The two environments require different `ORIGIN_TRUST_SECRET` values. The matching value is stored
as `NETOPIA_WORKER_TRUST_SECRET` on the corresponding Voyant Cloud API environment. It must never be
stored in source, Wrangler vars, a command argument, logs, or a test fixture used outside local
tests.

`NETOPIA_WORKER_URL` is the full RPC endpoint, not the Worker origin. Production is already live at
`https://voyant-netopia-worker.pixelmakers.workers.dev`; the platform value is therefore exactly
`https://voyant-netopia-worker.pixelmakers.workers.dev/rpc`. For staging, append `/rpc` to the URL
reported by Wrangler after the first reviewed deployment.

## Provisioning and release checklist

1. Review the exact source revision and run the repository's remote CI, Worker type-generation
   check, and both dry-run scripts. These commands may bundle code and therefore run
   on the approved remote build path, not the editing host.
2. Authenticate Wrangler to the Voyant Cloudflare account using the repository's least-privilege
   deployment profile.
3. Set the trust secret interactively for the target environment:

   ```sh
   wrangler secret put ORIGIN_TRUST_SECRET --config worker/wrangler.jsonc --env staging
   wrangler secret put ORIGIN_TRUST_SECRET --config worker/wrangler.jsonc --env production
   ```

   Do not paste a secret into a shell argument or commit `.dev.vars*`.
4. Deploy the reviewed revision through the approved Cloudflare build pipeline. Record the exact
   deployed URL and version ID.
5. Configure the matching Voyant Cloud environment with the full `NETOPIA_WORKER_URL` ending in
   `/rpc` and the same trust secret as `NETOPIA_WORKER_TRUST_SECRET`.
6. Verify that `/health` returns the expected environment, `/readyz` returns `200`, and the
   Cloudflare deployment status identifies the reviewed version. Then use the managed Payments connection flow to exercise the authenticated RPC health
   operation. Missing or mismatched trust configuration must return `401`.
7. In staging, complete one sandbox checkout, callback, and status lookup. Before live activation,
   complete a controlled live payment and refund/reconciliation procedure approved by the merchant.
8. Confirm Workers Logs contain structured failures without credentials, raw callbacks, billing
   details, or trust headers. Attach alerts for elevated `5xx`, `401`, and callback verification
   failure rates.

The RPC `health` operation currently validates credential shape and callback-verification material;
Netopia does not expose a side-effect-free merchant-authentication probe used by this adapter.
Therefore `/readyz` and Payments “connect” are necessary but not sufficient for live readiness. A
controlled end-to-end transaction is the live credential check.

## Callback and rollback constraints

Netopia must notify the managed operator endpoint
`/api/v1/public/payment-link/callback`. The operator runtime must receive an origin-only
`PAYMENT_CALLBACK_BASE_URL` which is independent from the customer-facing
`PUBLIC_CHECKOUT_BASE_URL`. ProTravel cutover requires a managed runtime release containing that
split; never point processor callbacks at the website's path-prefixed payment-link URL.

Rollback the Worker with Cloudflare Worker Versions. Existing payment sessions remain pinned to
the callback/runtime generation that created them until they settle or expire. Rotating the trust
secret without interruption requires a future dual-secret overlap protocol in both this Worker and
Voyant Cloud; until then, rotate only in a coordinated maintenance procedure or by switching the
platform to a separately deployed Worker endpoint.
