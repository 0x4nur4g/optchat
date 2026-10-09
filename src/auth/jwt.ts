import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

// ID-token validation for Sign in with ChatGPT. The token proves which account
// signed in, so it is verified against OpenAI's published keys before anything
// is stored. Claims checked: signature, issuer, audience, expiry and nonce.

export interface JwtHeader {
  alg: string;
  kid?: string;
  [key: string]: unknown;
}

export interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  sub?: unknown;
  [key: string]: unknown;
}

export interface DecodedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Buffer;
}

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  [key: string]: unknown;
}

function base64urlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(value: string): unknown {
  return JSON.parse(base64urlToBuffer(value).toString("utf8"));
}

/** Split and decode a compact JWS. Throws on malformed input. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("optchat: malformed id token");
  const [head, body, signature] = parts as [string, string, string];
  const header = decodeSegment(head) as JwtHeader;
  const payload = decodeSegment(body) as JwtPayload;
  if (typeof header !== "object" || header === null || typeof header.alg !== "string") {
    throw new Error("optchat: malformed id token header");
  }
  return {
    header,
    payload,
    signingInput: `${head}.${body}`,
    signature: base64urlToBuffer(signature),
  };
}

/**
 * JWS ECDSA signatures are raw r||s, but Node verifies DER. Convert without
 * touching the integers: drop nothing that is significant, only pad to whole
 * bytes and prepend a zero when the high bit would make DER read it negative.
 */
export function rsToDer(signature: Buffer, partLength: number): Buffer {
  if (signature.length !== partLength * 2) {
    throw new Error("optchat: unexpected ecdsa signature length");
  }
  const encode = (raw: Buffer): Buffer => {
    let value = raw;
    while (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
    if ((value[0] ?? 0) & 0x80) value = Buffer.concat([Buffer.from([0x00]), value]);
    const header = Buffer.from([0x02, value.length]);
    return Buffer.concat([header, value]);
  };
  const r = encode(signature.subarray(0, partLength));
  const s = encode(signature.subarray(partLength));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

const DIGEST: Record<string, string> = {
  RS256: "RSA-SHA256", RS384: "RSA-SHA384", RS512: "RSA-SHA512",
  PS256: "RSA-PSS-SHA256", PS384: "RSA-PSS-SHA384", PS512: "RSA-PSS-SHA512",
  ES256: "sha256", ES384: "sha384", ES512: "sha512",
  EdDSA: "ed25519",
};

const EC_PART: Record<string, number> = { ES256: 32, ES384: 48, ES512: 66 };

function selectKey(jwks: { keys?: Jwk[] }, header: JwtHeader): Jwk {
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const byKid = header.kid === undefined
    ? undefined
    : keys.find((key) => key.kid === header.kid);
  const candidate = byKid ?? keys.find((key) => key.alg === header.alg) ?? keys[0];
  if (candidate === undefined) throw new Error("optchat: no verification key available");
  return candidate;
}

function verifySignature(decoded: DecodedJwt, jwk: Jwk): boolean {
  const { alg } = decoded.header;
  const digest = DIGEST[alg];
  if (digest === undefined) throw new Error("optchat: unsupported id token algorithm");

  const key: KeyObject = createPublicKey({ key: jwk as never, format: "jwk" });
  const signature = alg.startsWith("ES")
    ? rsToDer(decoded.signature, EC_PART[alg] ?? 32)
    : decoded.signature;

  if (alg.startsWith("PS")) {
    return cryptoVerify(
      digest,
      Buffer.from(decoded.signingInput, "utf8"),
      { key, padding: 6, saltLength: 32 }, // RSA_PKCS1_PSS_PADDING
      signature,
    );
  }
  return cryptoVerify(digest, Buffer.from(decoded.signingInput, "utf8"), key, signature);
}

export interface VerifyOptions {
  issuer: string;
  /** The issued client id, which the token's audience must name. */
  audience: string;
  nonce: string;
  jwks: { keys?: Jwk[] };
  now?: number;
}

/**
 * Verify an ID token and return its payload. Throws on any failure: a token
 * that is merely well-formed proves nothing.
 */
export function verifyIdToken(token: string, options: VerifyOptions): JwtPayload {
  const decoded = decodeJwt(token);
  const payload = decoded.payload;

  if (!verifySignature(decoded, selectKey(options.jwks, decoded.header))) {
    throw new Error("optchat: id token signature is invalid");
  }
  if (payload.iss !== options.issuer) {
    throw new Error("optchat: id token issuer is invalid");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(options.audience)) {
    throw new Error("optchat: id token audience is invalid");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("optchat: id token has expired");
  }
  if (payload.nonce !== options.nonce) {
    throw new Error("optchat: id token nonce is invalid");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("optchat: id token has no subject");
  }
  return payload;
}
