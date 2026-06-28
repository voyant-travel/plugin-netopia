/**
 * Netopia implementation of the finance {@link CardPaymentStarter} contract.
 *
 * This is the one place that couples Netopia to a checkout surface: it resolves
 * the request-scoped Netopia runtime from the container, starts a hosted
 * payment via {@link startPaymentSession}, and returns the neutral
 * `redirectUrl` finance's contract expects. When the runtime isn't configured
 * it returns `null` so callers fall back (bank transfer still works).
 */
import type { CardPaymentStarter } from "@voyant-travel/finance/card-payment"

import { NETOPIA_RUNTIME_CONTAINER_KEY } from "./plugin.js"
import { startPaymentSession } from "./service-start.js"
import type { NetopiaBillingAddress, ResolvedNetopiaRuntimeOptions } from "./types.js"

/**
 * Build the Netopia card-payment starter. Select it as a deployment's
 * `CardPaymentStarter` to route every checkout surface's card payments through
 * Netopia.
 */
export function netopiaCardPaymentStarter(): CardPaymentStarter {
  return async (c, args) => {
    const runtime = c.var.container?.resolve(NETOPIA_RUNTIME_CONTAINER_KEY) as
      | ResolvedNetopiaRuntimeOptions
      | undefined
    if (!runtime) return null

    const started = await startPaymentSession(
      args.db,
      args.sessionId,
      {
        // The neutral CardPaymentBilling is structurally compatible with
        // Netopia's billing (same field names); callers always supply the full
        // Netopia-shaped object, so the cast is safe.
        billing: args.billing as NetopiaBillingAddress,
        description: args.description,
        returnUrl: args.returnUrl,
      },
      runtime,
    )

    return { redirectUrl: started.session.redirectUrl ?? null }
  }
}
