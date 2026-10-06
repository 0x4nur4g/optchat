import type { LogMessage, TreeNode } from "./constants";

/**
 * Single-page HTML dump of one chat: the rendered view, the ROOT of the tree,
 * every level as range/time/size rows, and the raw messages. Levels use the
 * same convention as zoom: a node at level l spans n = 2**l lines.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function spanOf(level: number): number {
  return 2 ** level;
}

/** First to last message date inside [start, end), or "-" when none. */
function timeSpan(start: number, end: number, dates: Map<number, string>): string {
  let first = "";
  let last = "";
  for (let i = start; i < end; i++) {
    const d = dates.get(i);
    if (d === undefined) continue;
    if (first === "") first = d;
    last = d;
  }
  if (first === "") return "-";
  return first === last ? first : `${first} to ${last}`;
}

export function toHTML(viewHtml: string, messages: LogMessage[], levels: TreeNode[]): string {
  const dates = new Map<number, string>();
  for (const m of messages) dates.set(m.i, m.date);

  const byLevel = new Map<number, TreeNode[]>();
  for (const node of levels) {
    const group = byLevel.get(node.l);
    if (group === undefined) byLevel.set(node.l, [node]);
    else group.push(node);
  }
  const levelIds = [...byLevel.keys()].sort((a, b) => a - b);

  const nodeRow = (node: TreeNode): string => {
    const span = spanOf(node.l);
    const start = node.i * span;
    const end = start + span;
    return (
      `<tr><td>${start}-${end}</td>` +
      `<td>${esc(timeSpan(start, end, dates))}</td>` +
      `<td>${node.size}</td>` +
      `<td><pre>${esc(node.text)}</pre></td></tr>`
    );
  };

  const table = (rows: string): string =>
    `<table><tr><th>Range</th><th>Time</th><th>Size</th><th>Text</th></tr>${rows}</table>`;

  const top = levelIds.length === 0 ? -1 : levelIds[levelIds.length - 1];
  const rootRows = top < 0 ? "" : (byLevel.get(top) ?? []).map(nodeRow).join("\n");

  const levelSections = levelIds
    .map((l) => {
      const rows = (byLevel.get(l) ?? []).map(nodeRow).join("\n");
      return `<h3>Level ${l} (span ${spanOf(l)})</h3>${table(rows)}`;
    })
    .join("\n");

  const messageRows = messages
    .map(
      (m) =>
        `<tr><td>${m.i}</td><td>${esc(m.kind)}</td><td>${esc(m.date)}</td>` +
        `<td>${m.size}</td><td><pre>${esc(m.text)}</pre></td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>optchat browse</title>
<style>
body{font-family:monospace;margin:1rem}
table{border-collapse:collapse;margin:.5rem 0}
td,th{border:1px solid #999;padding:.2rem .4rem;vertical-align:top;text-align:left}
pre{margin:0;white-space:pre-wrap}
h2{border-bottom:1px solid #999}
</style></head>
<body>
<h1>optchat</h1>
<section id="view"><h2>View</h2>${viewHtml}</section>
<section id="root"><h2>ROOT</h2>${table(rootRows)}</section>
<section id="levels"><h2>Levels</h2>${levelSections}</section>
<section id="messages"><h2>Messages</h2>${table(messageRows)}</section>
</body></html>`;
}