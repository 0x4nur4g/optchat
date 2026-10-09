import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * One signed-in ChatGPT account. Persisted as a separate owner-only file per
 * issued client id, outside the chat data directory on purpose: chat backups
 * are meant to be copied around, and OAuth credentials must never travel with
 * them.
 */
export interface CredentialRecord {
  email: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scopes: string[];
  saved_at: string;
  earliest_refresh_at?: string;
}

/** The fields a refresh rotates. Identity and registration stay put. */
export interface CredentialUpdate {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scopes: string[];
  saved_at: string;
  earliest_refresh_at?: string;
}

// Access tokens live one hour. Refresh five minutes before expiry so a long
// compaction turn is never cut short by a token expiring mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function safeName(clientId: string): string {
  return clientId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Absolute path of one account's credential file. */
export function credentialFile(dir: string, clientId: string): string {
  return path.join(dir, `${safeName(clientId)}.json`);
}

function isCredential(value: unknown): value is CredentialRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<CredentialRecord>;
  return typeof r.email === "string" &&
    typeof r.issuer === "string" &&
    typeof r.subject === "string" &&
    typeof r.client_id === "string" &&
    typeof r.ext_agent_host_id === "string" &&
    typeof r.id_token === "string" &&
    typeof r.access_token === "string" &&
    typeof r.refresh_token === "string" &&
    typeof r.token_type === "string" &&
    typeof r.expires_in === "number" && Number.isFinite(r.expires_in) &&
    Array.isArray(r.scopes) && r.scopes.every((s) => typeof s === "string") &&
    typeof r.saved_at === "string" && Number.isFinite(Date.parse(r.saved_at));
}

/** Write one record atomically with owner-only permissions. */
export async function saveCredential(dir: string, record: CredentialRecord): Promise<void> {
  if (!isCredential(record)) throw new Error("optchat: invalid credential record");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = credentialFile(dir, record.client_id);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // Rename is atomic, so a crash can never leave a half-written credential.
  await rename(tmp, file);
}

/** Read one account's record, or null when it was never saved. */
export async function loadCredential(
  dir: string,
  clientId: string,
): Promise<CredentialRecord | null> {
  let raw: string;
  try {
    raw = await readFile(credentialFile(dir, clientId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parse(raw);
}

/** Every saved account, for callers that do not know which one signed in. */
export async function loadCredentials(dir: string): Promise<CredentialRecord[]> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: CredentialRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const clientId = name.slice(0, -".json".length);
    const record = await loadCredential(dir, clientId).catch(() => null);
    if (record !== null) records.push(record);
  }
  return records;
}

function parse(raw: string): CredentialRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("optchat: corrupt credential file");
  }
  // Refuse rather than run with a half-populated record.
  if (!isCredential(parsed)) throw new Error("optchat: corrupt credential file");
  return parsed;
}

/** Replace the rotating token fields together, keeping identity untouched. */
export function applyRefresh(
  record: CredentialRecord,
  update: CredentialUpdate,
): CredentialRecord {
  return {
    email: record.email,
    issuer: record.issuer,
    subject: record.subject,
    client_id: record.client_id,
    ext_agent_host_id: record.ext_agent_host_id,
    id_token: record.id_token,
    access_token: update.access_token,
    refresh_token: update.refresh_token,
    token_type: update.token_type,
    expires_in: update.expires_in,
    scopes: [...update.scopes],
    saved_at: update.saved_at,
    ...(update.earliest_refresh_at === undefined
      ? {}
      : { earliest_refresh_at: update.earliest_refresh_at }),
  };
}

/** True when the access token is inside the refresh margin of expiry. */
export function needsRefresh(
  record: CredentialRecord,
  now: number,
  marginMs: number = REFRESH_MARGIN_MS,
): boolean {
  const savedAt = Date.parse(record.saved_at);
  if (!Number.isFinite(savedAt)) return true;
  return now >= savedAt + record.expires_in * 1000 - marginMs;
}
