import { handleCallback } from "./service-callback.js"
import {
  collectBookingGuarantee,
  collectBookingSchedule,
  collectInvoice,
} from "./service-collect.js"
import {
  deriveNetopiaOrderId,
  mapNetopiaPaymentStatus,
  type NetopiaCallbackResult,
  type NetopiaCollectPaymentResult,
  type NetopiaStartPaymentResult,
} from "./service-shared.js"
import { startPaymentSession } from "./service-start.js"

export {
  deriveNetopiaOrderId,
  mapNetopiaPaymentStatus,
  type NetopiaCallbackResult,
  type NetopiaCollectPaymentResult,
  type NetopiaStartPaymentResult,
}

export const netopiaService = {
  startPaymentSession,
  collectBookingSchedule,
  collectBookingGuarantee,
  collectInvoice,
  handleCallback,
}
