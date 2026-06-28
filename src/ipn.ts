/**
 * Netopia v2 IPN signature verification.
 *
 * Netopia v2 signs every IPN callback with a JWT carried in the
 * `Verification-token` HTTP header (see the official SDKs, e.g.
 * github.com/netopiapayments/go-sdk `VerifyIPN`):
 *
 *   - signed with RSA (RS256/RS384/RS512) using NETOPIA's platform key;
 *     merchants receive the platform certificate (PEM) to verify against
 *   - `iss` must be `"NETOPIA Payments"`
 *   - `aud` must contain the merchant's POS signature
 *   - `sub` is the base64 (standard alphabet) SHA-512 digest of the raw
 *     request body, binding the token to this exact payload
 *
 * This module implements that verification using only Web Crypto, so it
 * runs on Cloudflare Workers (no Node `crypto`). It accepts the key as
 * either a `CERTIFICATE` PEM (the SubjectPublicKeyInfo is extracted with a
 * minimal DER walk) or a `PUBLIC KEY` (SPKI) PEM.
 */

export type NetopiaIpnVerification = { ok: true } | { ok: false; reason: string }

export interface VerifyNetopiaIpnInput {
  /** Value of the `Verification-token` header. */
  token: string | null | undefined
  /** Raw (unparsed) request body, exactly as received. */
  rawBody: string
  /** The merchant POS signature the token's `aud` must match. */
  posSignature: string
  /** PEM: NETOPIA platform certificate or its public key. */
  publicKeyPem: string
}

const JWT_HASHES: Record<string, string> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
}

export async function verifyNetopiaIpnToken(
  input: VerifyNetopiaIpnInput,
): Promise<NetopiaIpnVerification> {
  const { token, rawBody, posSignature, publicKeyPem } = input

  if (!token) return { ok: false, reason: "missing_verification_token" }
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, reason: "malformed_verification_token" }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

  let header: { alg?: unknown }
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(base64UrlDecodeToString(headerB64)) as { alg?: unknown }
    claims = JSON.parse(base64UrlDecodeToString(payloadB64)) as Record<string, unknown>
  } catch {
    return { ok: false, reason: "malformed_verification_token" }
  }

  const alg = typeof header.alg === "string" ? header.alg.toUpperCase() : ""
  const hash = JWT_HASHES[alg]
  // Pinning to RSA algorithms also rejects `none` / HS* downgrade attempts.
  if (!hash) return { ok: false, reason: "unsupported_jwt_algorithm" }

  let key: CryptoKey
  try {
    key = await importRsaVerifyKey(publicKeyPem, hash)
  } catch {
    return { ok: false, reason: "invalid_public_key" }
  }

  let signatureValid = false
  try {
    signatureValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      toArrayBuffer(base64UrlDecodeToBytes(signatureB64)),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    )
  } catch {
    signatureValid = false
  }
  if (!signatureValid) return { ok: false, reason: "invalid_signature" }

  if (claims.iss !== "NETOPIA Payments") return { ok: false, reason: "invalid_issuer" }

  const aud = claims.aud
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter(isString) : []
  if (!audiences.some((value) => timingSafeStringEqual(value, posSignature))) {
    return { ok: false, reason: "invalid_audience" }
  }

  // Standard temporal claims, when present (60s clock-skew leeway).
  const nowSeconds = Date.now() / 1000
  if (typeof claims.exp === "number" && nowSeconds > claims.exp + 60) {
    return { ok: false, reason: "token_expired" }
  }
  if (typeof claims.nbf === "number" && nowSeconds < claims.nbf - 60) {
    return { ok: false, reason: "token_not_yet_valid" }
  }

  // `sub` binds the signed token to this exact body: base64(SHA-512(body)).
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(rawBody))
  const bodyHash = bytesToBase64(new Uint8Array(digest))
  if (!isString(claims.sub) || !timingSafeStringEqual(claims.sub, bodyHash)) {
    return { ok: false, reason: "payload_hash_mismatch" }
  }

  return { ok: true }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

/**
 * Constant-time string comparison (over UTF-16 code units). Length still
 * leaks, which is fine here — lengths of digests/POS signatures are public.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

async function importRsaVerifyKey(pem: string, hash: string): Promise<CryptoKey> {
  const der = pemToDer(pem)
  const spki = der.label === "CERTIFICATE" ? extractSpkiFromCertificate(der.bytes) : der.bytes
  return crypto.subtle.importKey(
    "spki",
    spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash },
    false,
    ["verify"],
  )
}

function pemToDer(pem: string): { label: string; bytes: Uint8Array } {
  const match = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]+?)-----END \1-----/)
  if (!match) throw new Error("Invalid PEM")
  const label = match[1] as string
  if (label !== "CERTIFICATE" && label !== "PUBLIC KEY") {
    throw new Error(`Unsupported PEM label: ${label}`)
  }
  const body = (match[2] as string).replace(/[\s\r\n]/g, "")
  return { label, bytes: base64DecodeToBytes(body) }
}

/**
 * Extracts the SubjectPublicKeyInfo from an X.509 certificate with a minimal
 * DER walk (Web Crypto has no certificate parser):
 *
 *   Certificate     ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate  ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature,
 *                                  issuer, validity, subject, subjectPublicKeyInfo, ... }
 */
function extractSpkiFromCertificate(der: Uint8Array): Uint8Array {
  const certificate = readDerElement(der, 0)
  const tbs = readDerElement(der, certificate.contentStart)

  let offset = tbs.contentStart
  // Optional explicit version tag: context-specific [0] constructed (0xa0).
  if (der[offset] === 0xa0) {
    offset = readDerElement(der, offset).end
  }
  // serialNumber, signature (algorithm), issuer, validity, subject.
  for (let i = 0; i < 5; i++) {
    offset = readDerElement(der, offset).end
  }
  const spki = readDerElement(der, offset)
  if (der[offset] !== 0x30) throw new Error("Malformed certificate: SPKI not a SEQUENCE")
  return der.subarray(offset, spki.end)
}

function readDerElement(der: Uint8Array, offset: number): { contentStart: number; end: number } {
  if (offset + 2 > der.length) throw new Error("Malformed DER: truncated element")
  let cursor = offset + 1 // skip tag
  let length = der[cursor] as number
  cursor += 1
  if (length & 0x80) {
    const lengthBytes = length & 0x7f
    if (lengthBytes === 0 || lengthBytes > 4 || cursor + lengthBytes > der.length) {
      throw new Error("Malformed DER: bad length")
    }
    length = 0
    for (let i = 0; i < lengthBytes; i++) {
      length = length * 256 + (der[cursor + i] as number)
    }
    cursor += lengthBytes
  }
  const end = cursor + length
  if (end > der.length) throw new Error("Malformed DER: content overruns buffer")
  return { contentStart: cursor, end }
}

function base64UrlDecodeToString(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(value))
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  return base64DecodeToBytes(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
}

function base64DecodeToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  return btoa(binary)
}
