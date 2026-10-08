import * as path from "node:path";
import { byteLen, type TreeNode } from "../constants";
import { nodeKey } from "../tree/address";
import { appendRecord, dayName, readRecords, validateScope } from "./jsonl";

export { nodeKey } from "../tree/address";

function isNode(value: unknown): value is TreeNode {
  if (value === null || typeof value !== "object") return false;
  const node = value as Partial<TreeNode>;
  return typeof node.l === "number" && Number.isSafeInteger(node.l) && node.l >= 0 && node.l <= 52 &&
    typeof node.i === "number" && Number.isSafeInteger(node.i) && node.i >= 0 &&
    Number.isSafeInteger((node.i + 1) * 2 ** node.l) &&
    typeof node.text === "string" && node.size === byteLen(node.text);
}

/** Directory holding tree nodes for a scope: <base>/tree/<scope> */
function treeDir(base: string, scope: string): string {
  validateScope(scope);
  return path.join(base, "tree", scope);
}

/** Local write-day file: <base>/tree/<scope>/YYYY-MM-DD.jsonl */
function dayFile(base: string, scope: string, dateISO: string): string {
  return path.join(treeDir(base, scope), dayName(dateISO));
}

/** Append one tree node ({l,i,text,size}) to today's file, fsync. */
export async function saveNode(
  base: string,
  scope: string,
  node: TreeNode,
): Promise<void> {
  if (!isNode(node)) throw new Error("optchat: invalid tree node");
  await appendRecord(dayFile(base, scope, new Date().toISOString()), {
    l: node.l, i: node.i, text: node.text, size: node.size,
  });
}

/** Load every node, keyed `${l}:${i}`. Later files win on duplicate keys. */
export async function loadAllNodes(
  base: string,
  scope: string,
): Promise<Map<string, TreeNode>> {
  const map = new Map<string, TreeNode>();
  for await (const { value, file, line } of readRecords(treeDir(base, scope))) {
    if (!isNode(value)) {
      console.warn(`optchat: skipping invalid tree record in ${file}:${line}`);
      continue;
    }
    map.set(nodeKey(value.l, value.i), value);
  }
  return map;
}
