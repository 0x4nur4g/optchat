import { fit, sawtooth, type IsBuilt, type Part, type SizeOf } from "./fold";

const LOW = 16000;
const HIGH = 32000;

/** A smaller, append-stable view derived only from the built master prefix. */
export class CompactionView {
  private master: Part[] | undefined;
  private parts: Part[] = [];

  update(master: Part[], T: number, sizes: SizeOf, isBuilt: IsBuilt): void {
    const merged = this.master === undefined || this.master.some((p, k) => {
      const next = master[k];
      return next === undefined || p.l !== next.l || p.i !== next.i;
    });
    const built: Part[] = [];
    for (const p of master) {
      if (!isBuilt(p.l, p.i)) break;
      built.push(p);
    }
    if (merged) {
      this.parts = fit(built, T, sizes, isBuilt, LOW);
    } else {
      const last = this.parts.at(-1);
      const end = last === undefined ? 0 : last.id + last.n;
      this.parts = sawtooth([...this.parts, ...built.filter((p) => p.id >= end)], T, sizes, isBuilt, HIGH, LOW);
    }
    this.master = master.slice();
  }

  /** Text only, never a placeholder or a partial line crossing the node end. */
  contextOf(l: number, i: number, textOf: (part: Part) => string | undefined): string[] {
    const end = l === 0 ? i : (i + 1) * 2 ** l;
    const lines: string[] = [];
    for (const p of this.parts) {
      if (p.id + p.n > end) break;
      const text = textOf(p);
      if (text === undefined) break;
      lines.push(text.replace(/\r\n|\r|\n/g, " "));
    }
    return lines;
  }
}
