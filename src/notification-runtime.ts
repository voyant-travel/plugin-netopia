import {
  createNotificationService,
  type NotificationProvider,
  type NotificationService,
} from "@voyant-travel/notifications"

import type { NetopiaRuntimeOptions } from "./types.js"

export type NetopiaNotificationRuntime = {
  dispatcher: NotificationService
}

export type NetopiaNotificationRuntimeOptions = Pick<
  NetopiaRuntimeOptions,
  "resolveNotificationProviders"
> & {
  notificationProviders?: ReadonlyArray<NotificationProvider>
}

export class NetopiaNotificationRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NetopiaNotificationRuntimeError"
  }
}

export function buildNetopiaNotificationRuntime(
  bindings: Record<string, unknown> | undefined,
  runtimeOptions: NetopiaNotificationRuntimeOptions = {},
  dispatcherOverride?: NotificationService,
): NetopiaNotificationRuntime {
  if (dispatcherOverride) {
    return {
      dispatcher: dispatcherOverride,
    }
  }

  const providers =
    runtimeOptions.resolveNotificationProviders?.(bindings ?? {}) ??
    runtimeOptions.notificationProviders

  if (!providers) {
    throw new NetopiaNotificationRuntimeError(
      "Netopia plugin requires `resolveNotificationProviders` or `notificationProviders` — there are no default providers.",
    )
  }

  return {
    dispatcher: createNotificationService(providers),
  }
}
