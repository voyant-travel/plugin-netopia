/**
 * Import-cheap deployment declaration owned by the Netopia adapter package.
 *
 * @voyant-travel/core@0.111.0 predates the dependency-free `./project`
 * authoring export, so this local type mirrors the `voyant.adapter.v1` fields
 * used here without importing the package's route or service graph.
 */
interface NetopiaVoyantAdapterManifest {
  schemaVersion: "voyant.adapter.v1"
  id: string
  packageName: string
  localId: string
  provides: {
    capabilities: readonly string[]
  }
  requires: {
    capabilities: readonly string[]
  }
  api: readonly {
    id: string
    surface: "admin" | "webhook"
    mount: string
    anonymous?: boolean
    transactional: boolean
    openapi?: {
      document: string
    }
    runtime: {
      entry: string
      export: string
    }
  }[]
  config: readonly {
    id: string
    key: string
    required?: boolean
    default?: string
  }[]
  secrets: readonly {
    id: string
    key: string
    required: boolean
    description: string
  }[]
  webhooks: readonly {
    id: string
    direction: "inbound"
    apiId: string
    secretIds: readonly string[]
  }[]
  providers?: readonly {
    id: string
    port: "payments.adapter.runtime"
    selection: {
      role: "payments"
      value: "netopia"
    }
    runtime: {
      entry: string
      export: string
    }
  }[]
  meta: {
    ownership: "package"
  }
}

const packageId = "@voyant-travel/netopia-adapter"
const adminApiId = `${packageId}#api.admin`
const webhookApiId = `${packageId}#api.webhook`
const apiKeySecretId = `${packageId}#secret.api-key`
const posSignatureSecretId = `${packageId}#secret.pos-signature`
const publicKeySecretId = `${packageId}#secret.public-key`

export const netopiaVoyantAdapter = {
  schemaVersion: "voyant.adapter.v1",
  id: packageId,
  packageName: packageId,
  localId: "netopia-adapter",
  provides: {
    capabilities: [
      "finance.card-payment",
      "finance.payment-provider.netopia",
      "payments.adapter.runtime",
    ],
  },
  requires: {
    capabilities: ["finance.payment-sessions", "notifications.delivery"],
  },
  api: [
    {
      id: adminApiId,
      surface: "admin",
      mount: "finance",
      transactional: true,
      openapi: { document: "netopia" },
      runtime: {
        entry: packageId,
        export: "createNetopiaFinanceExtension",
      },
    },
    {
      id: webhookApiId,
      surface: "webhook",
      mount: "finance",
      anonymous: true,
      transactional: true,
      runtime: {
        entry: packageId,
        export: "createNetopiaFinanceExtension",
      },
    },
  ],
  config: [
    {
      id: `${packageId}#config.mode`,
      key: "NETOPIA_SANDBOX",
      default: "true",
    },
    {
      id: `${packageId}#config.notify-url`,
      key: "NETOPIA_NOTIFY_URL",
      required: true,
    },
    {
      id: `${packageId}#config.redirect-url`,
      key: "NETOPIA_REDIRECT_URL",
      required: true,
    },
  ],
  secrets: [
    {
      id: apiKeySecretId,
      key: "NETOPIA_PRIVATE_KEY",
      required: true,
      description: "Netopia merchant private key or API credential.",
    },
    {
      id: posSignatureSecretId,
      key: "NETOPIA_MERCHANT_ID",
      required: true,
      description: "Netopia merchant identifier.",
    },
    {
      id: publicKeySecretId,
      key: "NETOPIA_PUBLIC_KEY",
      required: true,
      description: "Netopia platform public key used to verify inbound callbacks.",
    },
  ],
  webhooks: [
    {
      id: `${packageId}#webhook.ipn`,
      direction: "inbound",
      apiId: webhookApiId,
      secretIds: [apiKeySecretId, posSignatureSecretId, publicKeySecretId],
    },
  ],
  providers: [
    {
      id: `${packageId}#provider.payments.netopia`,
      port: "payments.adapter.runtime",
      selection: { role: "payments", value: "netopia" },
      runtime: {
        entry: packageId,
        export: "createNetopiaPaymentAdapter",
      },
    },
  ],
  meta: {
    ownership: "package",
  },
} as const satisfies NetopiaVoyantAdapterManifest

export default netopiaVoyantAdapter
