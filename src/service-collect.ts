import { type NotificationService, notificationsService } from "@voyant-travel/notifications"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { NetopiaClientApi } from "./client.js"
import {
  financeService,
  type NetopiaCollectBookingGuaranteeInput,
  type NetopiaCollectBookingScheduleInput,
  type NetopiaCollectInvoiceInput,
  type NetopiaCollectPaymentResult,
  resolveNotificationDispatcher,
} from "./service-shared.js"
import * as startService from "./service-start.js"
import type { NetopiaRuntimeOptions } from "./types.js"

export async function collectBookingSchedule(
  db: PostgresJsDatabase,
  scheduleId: string,
  input: NetopiaCollectBookingScheduleInput,
  runtimeOptions: NetopiaRuntimeOptions = {},
  clientOverride?: NetopiaClientApi,
  dispatcherOverride?: NotificationService,
  bindings?: Record<string, unknown>,
): Promise<NetopiaCollectPaymentResult> {
  const session = await financeService.createPaymentSessionFromBookingSchedule(db, scheduleId, {
    ...(input.paymentSession ?? {}),
    provider: "netopia",
  })

  if (!session) {
    throw new Error("Payment schedule not found")
  }

  const started = await startService.startPaymentSession(
    db,
    session.id,
    input.netopia,
    runtimeOptions,
    clientOverride,
    bindings,
  )

  const dispatcher = input.notification
    ? resolveNotificationDispatcher(bindings, runtimeOptions, dispatcherOverride)
    : null

  const paymentSessionNotification =
    input.notification && dispatcher
      ? await notificationsService.sendPaymentSessionNotification(
          db,
          dispatcher,
          started.session.id,
          input.notification,
        )
      : null

  return {
    ...started,
    paymentSessionNotification,
    invoiceNotification: null,
  }
}

export async function collectBookingGuarantee(
  db: PostgresJsDatabase,
  guaranteeId: string,
  input: NetopiaCollectBookingGuaranteeInput,
  runtimeOptions: NetopiaRuntimeOptions = {},
  clientOverride?: NetopiaClientApi,
  dispatcherOverride?: NotificationService,
  bindings?: Record<string, unknown>,
): Promise<NetopiaCollectPaymentResult> {
  const session = await financeService.createPaymentSessionFromBookingGuarantee(db, guaranteeId, {
    ...(input.paymentSession ?? {}),
    provider: "netopia",
  })

  if (!session) {
    throw new Error("Booking guarantee not found")
  }

  const started = await startService.startPaymentSession(
    db,
    session.id,
    input.netopia,
    runtimeOptions,
    clientOverride,
    bindings,
  )

  const dispatcher = input.notification
    ? resolveNotificationDispatcher(bindings, runtimeOptions, dispatcherOverride)
    : null

  const paymentSessionNotification =
    input.notification && dispatcher
      ? await notificationsService.sendPaymentSessionNotification(
          db,
          dispatcher,
          started.session.id,
          input.notification,
        )
      : null

  return {
    ...started,
    paymentSessionNotification,
    invoiceNotification: null,
  }
}

export async function collectInvoice(
  db: PostgresJsDatabase,
  invoiceId: string,
  input: NetopiaCollectInvoiceInput,
  runtimeOptions: NetopiaRuntimeOptions = {},
  clientOverride?: NetopiaClientApi,
  dispatcherOverride?: NotificationService,
  bindings?: Record<string, unknown>,
): Promise<NetopiaCollectPaymentResult> {
  const session = await financeService.createPaymentSessionFromInvoice(db, invoiceId, {
    ...(input.paymentSession ?? {}),
    provider: "netopia",
  })

  if (!session) {
    throw new Error("Invoice not found")
  }

  const started = await startService.startPaymentSession(
    db,
    session.id,
    input.netopia,
    runtimeOptions,
    clientOverride,
    bindings,
  )

  const shouldNotify = Boolean(input.paymentSessionNotification || input.invoiceNotification)
  const dispatcher = shouldNotify
    ? resolveNotificationDispatcher(bindings, runtimeOptions, dispatcherOverride)
    : null

  const paymentSessionNotification =
    input.paymentSessionNotification && dispatcher
      ? await notificationsService.sendPaymentSessionNotification(
          db,
          dispatcher,
          started.session.id,
          input.paymentSessionNotification,
        )
      : null

  const invoiceNotification =
    input.invoiceNotification && dispatcher
      ? await notificationsService.sendInvoiceNotification(
          db,
          dispatcher,
          invoiceId,
          input.invoiceNotification,
        )
      : null

  return {
    ...started,
    paymentSessionNotification,
    invoiceNotification,
  }
}
