# `@voyant-travel/plugin-netopia`

Netopia hosted-card payment adapter bundle for Voyant finance.

This package sits on top of `@voyant-travel/finance` and its `payment_sessions`
model. It does not replace finance state.

Architecturally, this package is primarily:

- a Netopia payment adapter
- a finance extension
- an optional packaged Hono bundle when an app wants one installable entrypoint

It starts a hosted Netopia checkout, stores provider references on the session,
and reconciles callback payloads back into Voyant payments, captures,
authorizations, invoices, and booking payment schedules.

## Environment

The default finance extension resolves its runtime config from:

- `NETOPIA_URL`
- `NETOPIA_API_KEY`
- `NETOPIA_POS_SIGNATURE`
- `NETOPIA_NOTIFY_URL`
- `NETOPIA_REDIRECT_URL`

You can also override these programmatically via `createNetopiaFinanceExtension(options)`.

## Routes

Mounted as a finance extension, the package exposes:

- `POST /providers/netopia/payment-sessions/:sessionId/start`
- `POST /providers/netopia/bookings/:bookingId/payment-schedules/:scheduleId/collect`
- `POST /providers/netopia/bookings/:bookingId/guarantees/:guaranteeId/collect`
- `POST /providers/netopia/invoices/:invoiceId/collect`
- `POST /providers/netopia/callback`
- `GET /providers/netopia/config`

## Checkout integration

If you use Finance-owned checkout collection routes, the package also exports
`createNetopiaCheckoutStarter()`. That lets checkout create the payment session
and start the Netopia redirect flow in one request while keeping provider
startup optional in core checkout.

Because this is a finance extension, these routes mount under the finance module
path in the app.

## Usage

```ts
import { createNetopiaFinanceAdapter } from "@voyant-travel/plugin-netopia"

const netopiaFinanceExtension = createNetopiaFinanceAdapter()
```

Then include the returned extension in `createApp({ extensions: [...] })`.

If you want the packaged distribution helper instead, use
`createNetopiaAdapterBundle()` or `netopiaHonoPlugin()`. Those are optional
distribution helpers over the adapter/extension surfaces above; the adapter and
finance extension remain the main runtime seams.

## Flow

1. Either create a finance `payment_session` yourself, or use one of the collect routes to create one from a booking schedule, guarantee, or invoice.
2. Start the hosted Netopia checkout.
3. Redirect the customer to the returned provider `paymentURL`.
4. Optionally send a payment-link or invoice notification as part of the collect flow.
5. Netopia calls the callback route.
6. The adapter completes, fails, or updates the session in finance.

## Notes

- Successful Netopia statuses default to `3` and `5`.
- In-flight statuses default to `1` and `15`.
- The callback path is idempotent for already-completed sessions.
- Amount/currency mismatch on a supposedly successful callback fails the session instead of silently accepting it.
