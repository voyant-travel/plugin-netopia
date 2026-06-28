import {
  createPaymentSessionFromGuaranteeSchema,
  createPaymentSessionFromInvoiceSchema,
  createPaymentSessionFromScheduleSchema,
} from "@voyant-travel/finance"
import {
  sendInvoiceNotificationSchema,
  sendPaymentSessionNotificationSchema,
} from "@voyant-travel/notifications"
import { z } from "zod"
import type { NetopiaFetch, NetopiaRuntimeOptions } from "./types.js"

export const netopiaBillingAddressSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  city: z.string().min(1),
  country: z.number().int().positive(),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  details: z.string().min(1),
})

export const netopiaProductLineSchema = z.object({
  name: z.string().optional(),
  code: z.string().optional(),
  category: z.string().optional(),
  price: z.number().positive().optional(),
  vat: z.number().min(0).optional(),
})

export const netopiaInstallmentsSchema = z.object({
  selected: z.number().int().positive(),
  available: z.array(z.number().int().nonnegative()).min(1),
})

export const netopiaPaymentOptionsSchema = z.object({
  installments: z.number().int().positive(),
  bonus: z.number().int().nonnegative().optional(),
})

export const netopiaPaymentInstrumentSchema = z.object({
  type: z.string().min(1),
  account: z.string().min(1),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000),
  secretCode: z.string().min(1),
  token: z.string().optional(),
})

export const netopiaBrowserDataSchema = z.record(z.string(), z.string().optional())

const optionalRuntimeUrl = z.string().trim().url().optional()

const optionalRuntimeString = z.string().trim().min(1).optional()

const optionalIntegerArray = z.array(z.number().int()).min(1).optional()

const optionalFetch = z.custom<NetopiaFetch | undefined>(
  (value) => value === undefined || typeof value === "function",
  "Expected a fetch implementation function",
)

const optionalProviderResolver = z.custom<NetopiaRuntimeOptions["resolveNotificationProviders"]>(
  (value) => value === undefined || typeof value === "function",
  "Expected a notification provider resolver function",
)

const optionalResilience = z.custom<NetopiaRuntimeOptions["resilience"]>(
  (value) => value === undefined || (typeof value === "object" && value !== null),
  "Expected valid resilience options",
)

export const netopiaRuntimeOptionsSchema = z.object({
  apiUrl: optionalRuntimeUrl,
  apiKey: optionalRuntimeString,
  posSignature: optionalRuntimeString,
  notifyUrl: optionalRuntimeUrl,
  redirectUrl: optionalRuntimeUrl,
  emailTemplate: optionalRuntimeString,
  language: optionalRuntimeString,
  successStatuses: optionalIntegerArray,
  processingStatuses: optionalIntegerArray,
  ipnPublicKey: optionalRuntimeString,
  trustUnverifiedCallbacks: z.boolean().optional(),
  fetch: optionalFetch.optional(),
  resilience: optionalResilience.optional(),
  resolveNotificationProviders: optionalProviderResolver.optional(),
})

export const resolvedNetopiaRuntimeOptionsSchema = z.object({
  apiUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1),
  posSignature: z.string().trim().min(1),
  notifyUrl: z.string().trim().url(),
  redirectUrl: z.string().trim().url(),
  emailTemplate: z.string().trim().min(1).default("confirm"),
  language: z.string().trim().min(1).default("ro"),
  successStatuses: z.array(z.number().int()).min(1).default([3, 5]),
  processingStatuses: z.array(z.number().int()).min(1).default([1, 15]),
  ipnPublicKey: z.string().trim().min(1).optional(),
  trustUnverifiedCallbacks: z.boolean().default(false),
  fetch: optionalFetch.optional(),
  resilience: optionalResilience.optional(),
})

export const netopiaStartPaymentSessionSchema = z.object({
  description: z.string().optional(),
  notifyUrl: z.string().url().optional(),
  returnUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
  emailTemplate: z.string().optional(),
  language: z.string().optional(),
  options: netopiaPaymentOptionsSchema.optional(),
  instrument: netopiaPaymentInstrumentSchema.optional(),
  browserData: netopiaBrowserDataSchema.optional(),
  billing: netopiaBillingAddressSchema,
  shipping: netopiaBillingAddressSchema.optional(),
  products: z.array(netopiaProductLineSchema).optional(),
  installments: netopiaInstallmentsSchema.optional(),
  orderData: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().nullable().optional(),
})

export const netopiaWebhookPayloadSchema = z.object({
  order: z.object({
    orderID: z.string().min(1),
  }),
  payment: z
    .object({
      amount: z.number(),
      currency: z.string().min(3),
      ntpID: z.string().min(1),
      status: z.number().int(),
      code: z.string().optional(),
      message: z.string().optional(),
      data: z
        .object({
          AuthCode: z.string().optional(),
          RRN: z.string().optional(),
        })
        .catchall(z.unknown())
        .optional(),
      instrument: z
        .object({
          country: z.number().int().optional(),
          panMasked: z.string().optional(),
        })
        .catchall(z.unknown())
        .optional(),
    })
    .catchall(z.unknown()),
})

export const netopiaCollectBookingScheduleSchema = z.object({
  paymentSession: createPaymentSessionFromScheduleSchema.optional(),
  netopia: netopiaStartPaymentSessionSchema,
  notification: sendPaymentSessionNotificationSchema.optional(),
})

export const netopiaCollectBookingGuaranteeSchema = z.object({
  paymentSession: createPaymentSessionFromGuaranteeSchema.optional(),
  netopia: netopiaStartPaymentSessionSchema,
  notification: sendPaymentSessionNotificationSchema.optional(),
})

export const netopiaCollectInvoiceSchema = z.object({
  paymentSession: createPaymentSessionFromInvoiceSchema.optional(),
  netopia: netopiaStartPaymentSessionSchema,
  paymentSessionNotification: sendPaymentSessionNotificationSchema.optional(),
  invoiceNotification: sendInvoiceNotificationSchema.optional(),
})
