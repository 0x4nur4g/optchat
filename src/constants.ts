export const NODE = 512; // target bytes per summary line
export const VIEW = 128_000; // view budget bytes (~62-64k tokens)
export const JOBS = 8; // parallel compactor calls
export const TRIES = 5; // size retries per node
export const RETRY_MS = 10_000; // failed node retry delay
export const CAP = 30_000; // max chars of tool result kept
export const MARKS = [50_000, 80_000, 100_000]; // cache breakpoints (chars)

export const SCOPES = ["global"] as const;
export type Scope = string;

export type Kind = "user" | "talk" | "tool" | "echo" | "note";

export interface LogMessage {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string; // ISO time
}

export interface TreeNode {
  l: number; // level
  i: number; // index at level
  text: string;
  size: number; // bytes of text
}

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function messageSize(kind: string, text: string): number {
  return byteLen(kind + ": " + text);
}
