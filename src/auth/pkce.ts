import { createHash, randomBytes } from "node:crypto";

// RFC 7636 code_verifier: 43-128 unreserved characters. 32 random bytes
// encode to exactly 43 base64url characters, the minimum that is still
// unguessable. Each authorization attempt gets a fresh pair.

const VERIFIER_BYTES = 32;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** base64url without padding, as PKCE requires. */
function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256 code_challenge for a verifier. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/** Fresh verifier and its challenge, one pair per authorization attempt. */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(VERIFIER_BYTES));
  return { verifier, challenge: challengeFor(verifier) };
}
