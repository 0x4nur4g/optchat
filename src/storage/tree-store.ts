import { mkdir, open, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { type TreeNode } from "../constants";

const DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Directory holding tree nodes for a scope: <base>/tree/<scope> */
function treeDir(base: string, scope: string): string {
  return path.join(base, "tree", scope);
}

/** Day file for an ISO date or time: <base>/tree/<scope>/YYYY-MM-DD.jsonl */
function dayFile(base: string, scope: string, dateISO: string): string {
  return path.join(treeDir(base, scope), dateISO.slice(0, 10) + ".jsonl");
}

/** Map key for a node position. */
export function nodeKey(l: number, i: number): string {
  return `${l}:${i}`;
}

/** Append one tree node ({l,i,text,size}) to today's file, fsync. */
export async function saveNode(
  base: string,
  scope: string,
  node: TreeNode,
): Promise<void> {
  const dir = treeDir(base, scope);
  await mkdir(dir, { recursive: true });
  const line =
    JSON.stringify({ l: node.l, i: node.i, text: node.text, size: node.size }) +
    "\n";
  const fh = await open(dayFile(base, scope, new Date().toISOString()), "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Load every node, keyed `${l}:${i}`. Later files win on duplicate keys. */
export async function loadAllNodes(
  base: string,
  scope: string,
): Promise<Map<string, TreeNode>> {
  const dir = treeDir(base, scope);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const map = new Map<string, TreeNode>();
  for (const name of names.filter((n) => DAY_RE.test(n)).sort()) {
    const file = path.join(dir, name);
    const raw = await readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const node = JSON.parse(line) as TreeNode;
        map.set(nodeKey(node.l, node.i), node);
      } catch {
        console.warn(`optchat: skipping torn line in ${file}`);
      }
    }
  }
  return map;
}

/** True when the map holds level l, index i. */
export function hasNode(
  map: Map<string, TreeNode>,
  l: number,
  i: number,
): boolean {
  return map.has(nodeKey(l, i));
}