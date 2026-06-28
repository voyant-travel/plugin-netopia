import type { CheckoutPaymentStarter } from "@voyant-travel/finance/checkout"

import { startPaymentSession } from "./service-start.js"
import type { NetopiaRuntimeOptions } from "./types.js"
import { netopiaStartPaymentSessionSchema } from "./validation.js"

export function createNetopiaCheckoutStarter(
  runtimeOptions: NetopiaRuntimeOptions = {},
): CheckoutPaymentStarter {
  return async ({ db, paymentSession, startProvider, bindings }) => {
    const input = netopiaStartPaymentSessionSchema.parse(startProvider.payload ?? {})
    const started = await startPaymentSession(
      db,
      paymentSession.id,
      input,
      runtimeOptions,
      undefined,
      bindings,
    )

    return {
      provider: "netopia",
      paymentSessionId: started.session.id,
      redirectUrl:
        started.session.redirectUrl ?? started.providerResponse.payment?.paymentURL ?? null,
      externalReference: started.session.externalReference ?? started.orderId,
      providerSessionId: started.session.providerSessionId ?? null,
      providerPaymentId: started.session.providerPaymentId ?? null,
      response: {
        orderId: started.orderId,
        providerResponse: started.providerResponse,
      },
    }
  }
}
