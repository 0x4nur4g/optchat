import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadOrCreateHostId } from "./host-id";
import { createPkce } from "./pkce";
import { verifyIdToken, type JwtPayload } from "./jwt";
import {
  applyRefresh,
  loadCredential,
  needsRefresh,
  saveCredential,
  type CredentialRecord,
} from "./credentials";

// Sign in with ChatGPT, plan usage. A public OAuth client: no client secret and
// no API key. The issued client id binds to one account and workspace, so it is
// saved and reused; `dynamic_agent_client` is only the first-registration entry
// point and must never be stored as the connection's id.

export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = [
  "openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE,
].join(" ");

const CALLBACK_PATH = "/auth/callback";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  earliest_refresh_at?: string;
}

export interface LoginOptions {
  authDir: string;
  /** Shown to the user during registration. Display metadata, not identity. */
  agentName?: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  /** Called with the authorization URL so a headless host can sign in manually. */
  onAuthorizeUrl?: (url: string) => void;
  now?: () => number;
}

function toForm(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("optchat: token endpoint returned malformed JSON");
  }
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`optchat: token response had no ${field}`);
  }
  return value;
}

/** Exchange an authorization code, or refresh an existing credential. */
async function postToken(
  fetchFn: typeof fetch,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: toForm(body),
  });
  const payload = await readBody(res);
  if (!res.ok) {
    // The provider's error body can echo request material; report the code only.
    const code = typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : `http_${res.status}`;
    throw new Error(`optchat: token request failed (${code})`);
  }
  const data = payload as Record<string, unknown>;
  return {
    access_token: requireString(data, "access_token"),
    refresh_token: typeof data["refresh_token"] === "string" ? data["refresh_token"] : undefined,
    id_token: typeof data["id_token"] === "string" ? data["id_token"] : undefined,
    token_type: typeof data["token_type"] === "string" ? data["token_type"] : "Bearer",
    expires_in: typeof data["expires_in"] === "number" ? data["expires_in"] : 3600,
    scope: typeof data["scope"] === "string" ? data["scope"] : undefined,
    earliest_refresh_at: typeof data["earliest_refresh_at"] === "string"
      ? data["earliest_refresh_at"] : undefined,
  };
}

/** Publish the loopback callback and return its exact redirect URI. */
function listenForCallback(): Promise<{
  redirectUri: string;
  result: Promise<{ code: string; clientId?: string; error?: string; state?: string }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settle: (value: { code: string; clientId?: string; error?: string; state?: string }) => void;
    let fail: (reason: Error) => void;
    const result = new Promise<{ code: string; clientId?: string; error?: string; state?: string }>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const clientId = url.searchParams.get("client_id") ?? undefined;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Sign-in complete. You can close this window.");
      settle({
        code: code ?? "",
        clientId,
        error: error ?? undefined,
        state: state ?? undefined,
      });
    });

    server.once("error", reject);
    // Port is picked by the OS; only the port may vary across sign-ins, the
    // scheme, host and path are fixed by the contract.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("optchat: could not bind the sign-in callback"));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        result,
        close: () => server.close(),
      });
    });
  });
}

function openBrowser(url: string): void {
  const child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.once("error", () => { /* no browser available: the URL is printed */ });
  child.unref();
}

/**
 * Run the full sign-in and store the resulting credential. Returns the record
 * so the caller can report which account is now connected.
 */
export async function login(options: LoginOptions): Promise<CredentialRecord> {
  const fetchFn = options.fetch ?? fetch;
  const launch = options.openBrowser ?? openBrowser;
  const now = options.now ?? Date.now;

  const hostId = await loadOrCreateHostId(options.authDir);

  // A returning account reuses its issued client id, which also skips the
  // account selector and any workspace prompt.
  const existing = await findReturning(options.authDir);
  const isFirstRegistration = existing === null;
  const clientId = existing?.client_id ?? DYNAMIC_CLIENT_ID;

  const state = randomToken();
  const nonce = randomToken();
  const pkce = createPkce();
  const listener = await listenForCallback();

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: listener.redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: pkce.challenge,
    });
    if (isFirstRegistration && options.agentName !== undefined) {
      params.set("agent_name_hint", options.agentName);
    }

    const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;
    // Printed as well as opened: an always-on host often has no browser, and
    // the URL is the only way to complete sign-in there.
    options.onAuthorizeUrl?.(authorizeUrl);
    await launch(authorizeUrl);

    const callback = await listener.result;
    if (callback.error !== undefined) {
      throw new Error(`optchat: sign-in was not completed (${callback.error})`);
    }
    if (callback.state !== state) {
      throw new Error("optchat: sign-in state mismatch");
    }
    if (callback.code.length === 0) {
      throw new Error("optchat: sign-in returned no code");
    }

    // A new registration must hand back the issued id. Never save the
    // registration entrypoint as the connection's client id.
    const issuedClientId = callback.clientId ?? clientId;
    if (issuedClientId === DYNAMIC_CLIENT_ID) {
      throw new Error("optchat: registration did not issue a client id");
    }
    if (!isFirstRegistration && callback.clientId !== undefined && callback.clientId !== clientId) {
      throw new Error("optchat: sign-in returned a different client id");
    }

    const token = await postToken(fetchFn, {
      grant_type: "authorization_code",
      client_id: issuedClientId,
      code: callback.code,
      code_verifier: pkce.verifier,
      redirect_uri: listener.redirectUri,
      resource: RESOURCE,
    });

    return await finishLogin(fetchFn, options.authDir, {
      issuedClientId,
      hostId,
      token,
      nonce,
      now,
    });
  } finally {
    listener.close();
  }
}

async function findReturning(authDir: string): Promise<CredentialRecord | null> {
  const { readdir } = await import("node:fs/promises");
  const { credentialFile } = await import("./credentials");
  let names: string[];
  try {
    names = await readdir(authDir);
  } catch {
    return null;
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const clientId = name.slice(0, -".json".length);
    const record = await loadCredential(authDir, clientId).catch(() => null);
    if (record !== null) return record;
  }
  return null;
}

async function finishLogin(
  fetchFn: typeof fetch,
  authDir: string,
  args: {
    issuedClientId: string;
    hostId: string;
    token: TokenResponse;
    nonce: string;
    now: () => number;
  },
): Promise<CredentialRecord> {
  const { token } = args;

  // Plan usage is granted by scope, not by holding a valid token.
  const granted = (token.scope ?? "").split(/\s+/).filter(Boolean);
  if (!granted.includes(PLAN_SCOPE)) {
    throw new Error("optchat: ChatGPT plan usage was not authorized");
  }

  if (token.id_token === undefined) throw new Error("optchat: sign-in returned no id token");
  const discovery = await readBody(await fetchFn(DISCOVERY_URL)) as { jwks_uri?: unknown };
  const jwksUri = typeof discovery.jwks_uri === "string"
    ? discovery.jwks_uri
    : `${ISSUER}/.well-known/jwks.json`;
  const jwks = await readBody(await fetchFn(jwksUri)) as { keys?: unknown[] };

  let claims: JwtPayload;
  try {
    claims = verifyIdToken(token.id_token, {
      issuer: ISSUER,
      audience: args.issuedClientId,
      nonce: args.nonce,
      jwks: jwks as never,
      now: Math.floor(args.now() / 1000),
    });
  } catch (err) {
    throw err;
  }

  const record: CredentialRecord = {
    email: typeof claims["email"] === "string" ? claims["email"] : "",
    issuer: ISSUER,
    subject: String(claims["sub"]),
    client_id: args.issuedClientId,
    ext_agent_host_id: args.hostId,
    id_token: token.id_token,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    token_type: token.token_type,
    expires_in: token.expires_in,
    scopes: granted,
    saved_at: new Date(args.now()).toISOString(),
    ...(token.earliest_refresh_at === undefined
      ? {} : { earliest_refresh_at: token.earliest_refresh_at }),
  };
  await saveCredential(authDir, record);
  return record;
}

/**
 * Refresh one account's access token when it is near expiry. Returns null when
 * no refresh is needed. The rotating refresh token replaces the old one.
 */
export async function refreshIfDue(
  record: CredentialRecord,
  options: { fetch?: typeof fetch; now?: () => number; authDir: string },
): Promise<CredentialRecord | null> {
  const now = (options.now ?? Date.now)();
  if (!needsRefresh(record, now)) return null;
  if (record.refresh_token.length === 0) {
    throw new Error("optchat: credential has no refresh token; sign in again");
  }
  const token = await postToken(options.fetch ?? fetch, {
    grant_type: "refresh_token",
    client_id: record.client_id,
    refresh_token: record.refresh_token,
    resource: RESOURCE,
  });
  const refreshed = applyRefresh(record, {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? record.refresh_token,
    token_type: token.token_type,
    expires_in: token.expires_in,
    scopes: (token.scope ?? record.scopes.join(" ")).split(/\s+/).filter(Boolean),
    saved_at: new Date(now).toISOString(),
    ...(token.earliest_refresh_at === undefined
      ? {} : { earliest_refresh_at: token.earliest_refresh_at }),
  });
  await saveCredential(options.authDir, refreshed);
  return refreshed;
}
