import { OpenAPIHono, z } from "@hono/zod-openapi"
import type { Extension, ModuleContainer } from "@voyant-travel/core"
import {
  FINANCE_ROUTE_RUNTIME_CONTAINER_KEY,
  type FinanceRouteRuntime,
} from "@voyant-travel/finance"
import {
  defineHonoBundle,
  type HonoBundle,
  idempotencyKey,
  parseJsonBody,
} from "@voyant-travel/hono"
import type { HonoExtension } from "@voyant-travel/hono/module"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { MiddlewareHandler } from "hono"
import { Hono } from "hono"

import { resolveNetopiaRuntimeOptions } from "./client.js"
import { verifyNetopiaIpnToken } from "./ipn.js"
import { netopiaService } from "./service.js"
import type { NetopiaRuntimeOptions, ResolvedNetopiaRuntimeOptions } from "./types.js"
import {
  netopiaCollectBookingGuaranteeSchema,
  netopiaCollectBookingScheduleSchema,
  netopiaCollectInvoiceSchema,
  netopiaStartPaymentSessionSchema,
  netopiaWebhookPayloadSchema,
} from "./validation.js"

type Env = {
  Bindings: Record<string, unknown>
  Variables: {
    container: ModuleContainer
    db: PostgresJsDatabase
    userId?: string
  }
}

export const NETOPIA_RUNTIME_CONTAINER_KEY = "providers.netopia.runtime"
export const NETOPIA_ADMIN_OPENAPI_API_ID = "@voyant-travel/plugin-netopia#api.admin"

function getNetopiaRuntime(
  bindings: Record<string, unknown>,
  options: NetopiaRuntimeOptions,
  resolveFromContainer?: <T>(key: string) => T,
): ResolvedNetopiaRuntimeOptions {
  if (resolveFromContainer) {
    try {
      return resolveFromContainer<ResolvedNetopiaRuntimeOptions>(NETOPIA_RUNTIME_CONTAINER_KEY)
    } catch {
      // Fall through to per-request resolution when bootstrap has not run.
    }
  }

  return resolveNetopiaRuntimeOptions(bindings, options)
}

/**
 * Netopia doesn't send an `Idempotency-Key` header — its retry identity is
 * the (ntpID, status) pair in the callback payload (`ntpID` is the Netopia
 * transaction id; `status` distinguishes the processing/paid/failed events
 * of the same transaction). This middleware derives a synthetic
 * `Idempotency-Key` from that pair so the standard `idempotencyKey()`
 * middleware (and its `infra idempotency_keys` storage) dedupes provider
 * retries exactly like client-keyed mutations — no parallel dedup
 * mechanism. Unparseable payloads pass through unkeyed and fall back to
 * the handler's own already-completed guards.
 */
function netopiaCallbackEventKey(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!c.req.header("Idempotency-Key")) {
      const rawBody = await c.req.text()
      let headers: Headers | undefined
      try {
        const parsed = JSON.parse(rawBody) as { payment?: { ntpID?: unknown; status?: unknown } }
        const ntpId = parsed?.payment?.ntpID
        const status = parsed?.payment?.status
        if (typeof ntpId === "string" && ntpId.length > 0 && typeof status === "number") {
          headers = new Headers(c.req.raw.headers)
          headers.set("Idempotency-Key", `netopia:${ntpId}:${status}`)
        }
      } catch {
        // Not JSON — let the validation layer reject it downstream.
      }
      // `c.req.text()` consumed the body; rebuild the request so the
      // idempotency middleware / handler can re-read it.
      c.set("netopiaCallbackRawBody" as never, rawBody as never)
      c.req.raw = new Request(c.req.raw, headers ? { body: rawBody, headers } : { body: rawBody })
    }
    return next()
  }
}

export function createNetopiaFinanceRoutes(options: NetopiaRuntimeOptions = {}) {
  const handleNetopiaError = (message: string) => {
    if (
      message.includes("not found") ||
      message.includes("Payment schedule not found") ||
      message.includes("Booking guarantee not found") ||
      message.includes("Invoice not found")
    ) {
      return { status: 404 as const, message }
    }
    if (message.includes("not startable") || message.includes("already assigned")) {
      return { status: 409 as const, message }
    }
    if (
      message.includes("Cannot create payment session") ||
      message.includes("outstanding balance") ||
      message.includes("No recipient available")
    ) {
      return { status: 409 as const, message }
    }
    if (message.includes("Missing Netopia config")) {
      return { status: 500 as const, message }
    }
    return { status: 502 as const, message }
  }
  const resolveRuntime = (c: {
    env: Record<string, unknown>
    var: { container: ModuleContainer }
  }) => getNetopiaRuntime(c.env, options, (key) => c.var.container.resolve(key))

  const routes = new OpenAPIHono<Env>()
  routes
    .post("/providers/netopia/payment-sessions/:sessionId/start", idempotencyKey(), async (c) => {
      try {
        const data = await parseJsonBody(c, netopiaStartPaymentSessionSchema)
        const runtime = resolveRuntime(c)
        const result = await netopiaService.startPaymentSession(
          c.get("db"),
          c.req.param("sessionId"),
          data,
          runtime,
          undefined,
        )
        return c.json({ data: result }, 201)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start Netopia payment"
        if (message.includes("Payment session not found")) {
          return c.json({ error: message }, 404)
        }
        if (message.includes("not startable") || message.includes("already assigned")) {
          return c.json({ error: message }, 409)
        }
        if (message.includes("Missing Netopia config")) {
          return c.json({ error: message }, 500)
        }
        return c.json({ error: message }, 502)
      }
    })
    .post(
      "/providers/netopia/bookings/:bookingId/payment-schedules/:scheduleId/collect",
      idempotencyKey(),
      async (c) => {
        try {
          const data = await parseJsonBody(c, netopiaCollectBookingScheduleSchema)
          const runtime = resolveRuntime(c)
          const result = await netopiaService.collectBookingSchedule(
            c.get("db"),
            c.req.param("scheduleId"),
            data,
            runtime,
            undefined,
            undefined,
            c.env,
          )
          return c.json({ data: result }, 201)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to collect schedule payment"
          const response = handleNetopiaError(message)
          return c.json({ error: response.message }, response.status)
        }
      },
    )
    .post(
      "/providers/netopia/bookings/:bookingId/guarantees/:guaranteeId/collect",
      idempotencyKey(),
      async (c) => {
        try {
          const data = await parseJsonBody(c, netopiaCollectBookingGuaranteeSchema)
          const runtime = resolveRuntime(c)
          const result = await netopiaService.collectBookingGuarantee(
            c.get("db"),
            c.req.param("guaranteeId"),
            data,
            runtime,
            undefined,
            undefined,
            c.env,
          )
          return c.json({ data: result }, 201)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to collect guarantee payment"
          const response = handleNetopiaError(message)
          return c.json({ error: response.message }, response.status)
        }
      },
    )
    .post("/providers/netopia/invoices/:invoiceId/collect", idempotencyKey(), async (c) => {
      try {
        const data = await parseJsonBody(c, netopiaCollectInvoiceSchema)
        const runtime = resolveRuntime(c)
        const result = await netopiaService.collectInvoice(
          c.get("db"),
          c.req.param("invoiceId"),
          data,
          runtime,
          undefined,
          undefined,
          c.env,
        )
        return c.json({ data: result }, 201)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to collect invoice payment"
        const response = handleNetopiaError(message)
        return c.json({ error: response.message }, response.status)
      }
    })
    .get("/providers/netopia/config", async (c) => {
      try {
        const runtime = resolveRuntime(c)
        return c.json({
          data: {
            apiUrl: runtime.apiUrl,
            notifyUrl: runtime.notifyUrl,
            redirectUrl: runtime.redirectUrl,
            emailTemplate: runtime.emailTemplate,
            language: runtime.language,
            successStatuses: runtime.successStatuses,
            processingStatuses: runtime.processingStatuses,
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Missing Netopia config"
        return c.json({ error: message }, 500)
      }
    })

  for (const [method, path, summary] of [
    [
      "post",
      "/providers/netopia/payment-sessions/{sessionId}/start",
      "Start a Netopia payment session",
    ],
    [
      "post",
      "/providers/netopia/bookings/{bookingId}/payment-schedules/{scheduleId}/collect",
      "Collect a booking payment schedule through Netopia",
    ],
    [
      "post",
      "/providers/netopia/bookings/{bookingId}/guarantees/{guaranteeId}/collect",
      "Collect a booking guarantee through Netopia",
    ],
    [
      "post",
      "/providers/netopia/invoices/{invoiceId}/collect",
      "Collect an invoice through Netopia",
    ],
    ["get", "/providers/netopia/config", "Read the public Netopia runtime configuration"],
  ] as const) {
    const parameterNames = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1])

    routes.openAPIRegistry.registerPath({
      method,
      path,
      summary,
      request:
        parameterNames.length > 0
          ? {
              params: z.object(
                Object.fromEntries(parameterNames.map((name) => [name, z.string()])),
              ),
            }
          : undefined,
      responses: { 200: { description: "Netopia finance operation response." } },
      "x-voyant-api-id": NETOPIA_ADMIN_OPENAPI_API_ID,
    })
  }

  return routes
}

/**
 * Inbound Netopia IPN callback — POSTed by Netopia's servers with no session;
 * the handler verifies the JWT/signature in-band (ADR-0008). Lives on its own
 * `webhookRoutes` instance (not `routes`) so it is anonymous-by-construction and
 * survives removal of the deprecated legacy mount. Mounted at `/v1/finance`, so
 * the externally-registered callback URL `/v1/finance/providers/netopia/callback`
 * is unchanged.
 */
export function createNetopiaFinanceWebhookRoutes(options: NetopiaRuntimeOptions = {}) {
  const resolveRuntime = (c: {
    env: Record<string, unknown>
    var: { container: ModuleContainer }
  }) => getNetopiaRuntime(c.env, options, (key) => c.var.container.resolve(key))

  return new Hono<Env>().post(
    "/providers/netopia/callback",
    netopiaCallbackEventKey(),
    idempotencyKey(),
    async (c) => {
      const payload = await parseJsonBody(c, netopiaWebhookPayloadSchema)
      const runtime = resolveRuntime(c)
      const rawBody = c.get("netopiaCallbackRawBody" as never) as string | undefined
      if (!runtime.trustUnverifiedCallbacks) {
        if (!runtime.ipnPublicKey) {
          return c.json(
            {
              error: "Netopia callback verification is not configured",
              code: "netopia_callback_verification_not_configured",
            },
            503,
          )
        }
        const verification = await verifyNetopiaIpnToken({
          token:
            c.req.header("Verification-token") ??
            c.req.header("verification-token") ??
            c.req.header("X-Netopia-Verification-Token"),
          rawBody: rawBody ?? JSON.stringify(payload),
          posSignature: runtime.posSignature,
          publicKeyPem: runtime.ipnPublicKey,
        })
        if (!verification.ok) {
          return c.json(
            {
              error: "Netopia callback verification failed",
              code: verification.reason,
            },
            401,
          )
        }
      }
      const financeRuntime = (() => {
        try {
          return c.var.container?.resolve<FinanceRouteRuntime>(FINANCE_ROUTE_RUNTIME_CONTAINER_KEY)
        } catch {
          return undefined
        }
      })()
      const result = await netopiaService.handleCallback(
        c.get("db"),
        payload,
        runtime,
        c.env,
        financeRuntime ? { eventBus: financeRuntime.eventBus } : undefined,
      )
      if (result.action === "deferred") {
        return c.json({ data: result }, 503)
      }
      return c.json({ data: result })
    },
  )
}

const netopiaFinanceExtensionDef: Extension = {
  name: "netopia-finance",
  module: "finance",
}

export function createNetopiaFinanceExtension(options: NetopiaRuntimeOptions = {}): HonoExtension {
  return {
    extension: netopiaFinanceExtensionDef,
    // Operator-initiated payment ops (start a session / collect an invoice / read
    // config) — staff-guarded, mounted at `/v1/admin/finance/providers/netopia/*`.
    // The `/v1/admin/finance` prefix shares finance's transactional-db routing
    // (app.ts derives all three surfaces from `requiresTransactionalDb`), so the
    // payment-session writes keep the transaction-capable client. The Netopia IPN
    // callback stays on `webhookRoutes` (anonymous, signature-verified).
    adminRoutes: createNetopiaFinanceRoutes(options),
    webhookRoutes: createNetopiaFinanceWebhookRoutes(options),
  }
}

export function netopiaHonoBundle(options: NetopiaRuntimeOptions = {}): HonoBundle {
  return defineHonoBundle({
    name: "netopia",
    version: "0.1.0",
    bootstrap: ({ bindings, container }) => {
      try {
        container.register(
          NETOPIA_RUNTIME_CONTAINER_KEY,
          resolveNetopiaRuntimeOptions(bindings as Record<string, unknown> | undefined, options),
        )
      } catch (error) {
        // Defer resolution to per-request handlers. Missing env should only fail
        // Netopia-owned routes, not the whole app — `getNetopiaRuntime` will retry
        // from bindings on each request and surface the same error on Netopia calls.
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[netopia] Runtime bootstrap skipped: ${message}`)
      }
    },
    // The Netopia IPN callback (Netopia POSTs the payment result with no session;
    // the handler verifies the processor signature in-band, ADR-0008) lives on the
    // extension's `webhookRoutes`, so the framework auto-adds
    // `/v1/finance/providers/netopia/callback` to the anonymous allow-list — no
    // bundle-level `anonymous` declaration or deployment `publicPaths` entry.
    extensions: [createNetopiaFinanceExtension(options)],
  })
}

/** @deprecated Prefer {@link netopiaHonoBundle}. */
export const netopiaHonoPlugin = netopiaHonoBundle

export const netopiaFinanceExtension = createNetopiaFinanceExtension()
