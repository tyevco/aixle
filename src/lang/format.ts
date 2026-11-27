/**
 * `aixle fmt`: one layout for a program, so a diff is about the model and
 * not about who typed it.
 *
 * The formatter never adds, drops or reorders a token and never joins or
 * splits a line: it re-lays the space between tokens, so it cannot change
 * what a program means. Each token is printed as written (a number stays
 * `0.50`, a string keeps its quotes). On a line:
 *
 *   - one space around `=`, `|`, the operators and after a keyword; none
 *     around the `=` of a named argument or a default (`round=0.1`), after a
 *     unary minus or a call's name, inside brackets, before `,` and `:`, or
 *     around `.`; one after a record's `:`, and one inside a loop's braces
 *     when its body shares their line;
 *   - after a comma, the space the author wrote, none, one or more, because
 *     points are written `[x,y,z, x,y,z]` and a table of numbers is lined up
 *     with it; only the space before a comma is taken away;
 *   - an assignment's `=`, or a record's value after its `:`, that the author
 *     padded into the same column as the line above or below keeps that column,
 *     and so does every line of the column: where the layout would move them
 *     apart (a line re-indented, the code before one respaced), the column goes
 *     as far right as the furthest of them.
 *
 * Between lines:
 *
 *   - a statement starts at its block's indentation, two spaces per loop;
 *   - a line that continues a statement keeps its break. A closing bracket
 *     that starts it goes at its opener's line. A line written two in from
 *     the line that opened its bracket (or from the statement, with none
 *     open) is a hanging indent and stays one. Otherwise a line written under
 *     an argument, an item, an entry, a value or an `=` of an earlier line of
 *     the statement stays under it, wherever the formatting moved it (an
 *     argument lined up with the first stays lined up). Inside brackets, a
 *     line that starts with an operator and was written further in than the
 *     line above it in the same brackets carries that line's item on, and
 *     stays two in from it (`  box(1)` over `    | move(0, 1, 0)`). Anything
 *     else becomes a hanging indent;
 *   - blank lines: one where the author had one or more, none at the start
 *     or the end of the file;
 *   - a comment on its own line takes the indentation of the line it
 *     precedes (inside the brackets or the loop when that line closes them);
 *     a comment after code has at least two spaces before it and otherwise
 *     keeps its column, moved with its line's indentation; comments at one
 *     column on consecutive lines are a column and move as one, as far right
 *     as the furthest of them needs, so a column stays a column when one
 *     line's code reaches into it. A comment's text is kept as written.
 */
import { parseTokens } from "./parser.js";
import type { Token } from "./lexer.js";

const KEYWORDS = new Set(["def", "for", "in", "show", "scene", "set", "use", "assert"]);

const isOp = (t: Token, v: string): boolean => t.type === "op" && t.value === v;
/** The operators a line can start with to carry on the line above, as the lexer reads them. */
const CARRIES = new Set(["+", "-", "*", "/", "|", "&"]);
const isKeyword = (t: Token): boolean => t.type === "ident" && (KEYWORDS.has(t.value) || t.role === "keyword");
const isBlockOpen = (t: Token): boolean => isOp(t, "{") && t.role !== "record";
const isBlockClose = (t: Token): boolean => isOp(t, "}") && t.role !== "record";
const isOpener = (t: Token): boolean => isOp(t, "(") || isOp(t, "[") || (isOp(t, "{") && t.role === "record");
const isCloser = (t: Token): boolean => isOp(t, ")") || isOp(t, "]") || (isOp(t, "}") && t.role === "record");

/** The space between two tokens on one line; `gap` is what the author wrote there (spaces only). */
function spacing(a: Token, b: Token, gap: string): string {
  if (isOp(b, ",") || isOp(b, ":")) return "";
  if (isCloser(b)) return "";
  if (isOp(a, ",")) return " ".repeat(gap.length);
  if (isOpener(a)) return "";
  if (isOp(a, ".") || isOp(b, ".") || isOp(a, "...")) return "";
  if (b.role === "index") return "";
  if (isOp(b, "(") && a.type === "ident" && !isKeyword(a)) return "";
  if (a.role === "unary") return "";
  if (a.role === "named" || b.role === "named") return "";
  // Everything else is one space: around the operators and `=`, after `:` and a keyword, inside a loop's braces.
  return " ";
}

/** A comment's text, as written but for trailing space; `seg` holds only space and the comment. */
const commentIn = (seg: string): { text: string; at: number } | undefined => {
  const at = seg.search(/\S/);
  return at < 0 ? undefined : { text: seg.slice(at).trimEnd(), at };
};

export function format(source: string): string {
  // A lone \r is space to the lexer, and inside a comment it is part of the comment: only a \r\n is a line break.
  const src = source.replace(/\r\n/g, "\n");
  const { tokens } = parseTokens(src);
  const toks: Token[] = [];
  const startsStatement: boolean[] = [];
  let pending = true;
  // A record's entries may sit on lines of their own; the line breaks inside one do not end a statement.
  let inRecord = 0;
  for (const t of tokens) {
    if (t.type === "newline") { if (inRecord === 0) pending = true; continue; }
    if (t.type === "eof") break;
    if (isOp(t, "{") && t.role === "record") inRecord++;
    else if (isOp(t, "}") && t.role === "record") inRecord--;
    startsStatement.push(pending || (toks.length > 0 && isBlockOpen(toks[toks.length - 1])));
    toks.push(t);
    pending = false;
  }
  const columnOf = (offset: number): number => offset - (src.lastIndexOf("\n", offset - 1) + 1);
  const assignEq = (t: Token) => isOp(t, "=") && t.role === undefined;

  // Columns the author lined up: an assignment's or a def's `=`, or a value after a record's `:`, padded into the
  // column of one on the line above or below. Each run of such lines is one column. It starts where the author
  // wrote it, moved with its line's indentation, and is then settled on what is printed: wherever its lines landed
  // apart (one re-indented further than the other, or the code before it respaced), the column goes as far right as
  // the furthest of them, so a column stays a column and a second run finds it where the first left it.
  const marks: { i: number; line: number; kind: string; col: number; padded: boolean }[] = [];
  toks.forEach((t, i) => {
    if (i === 0 || t.line !== toks[i - 1].line) return;
    const kind = assignEq(t) ? "=" : isOp(toks[i - 1], ":") ? ":" : undefined;
    if (kind) marks.push({ i, line: t.line, kind, col: columnOf(t.start), padded: t.start - toks[i - 1].end > 1 });
  });
  const parent = marks.map((_, k) => k);
  const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])));
  for (let a = 0; a < marks.length; a++)
    for (let b = a + 1; b < marks.length && marks[b].line <= marks[a].line + 1; b++)
      if (marks[b].line === marks[a].line + 1 && marks[b].kind === marks[a].kind && marks[b].col === marks[a].col) parent[root(b)] = root(a);
  const runs = new Map<number, typeof marks>();
  marks.forEach((m, k) => { const r = root(k); runs.set(r, [...(runs.get(r) ?? []), m]); });
  const columns = [...runs.values()].filter((run) => run.length > 1 && run.some((m) => m.padded));
  /** The lined-up tokens, each with the column it was written at; and, once settled, the column it goes to. */
  const linedUp = new Map<number, number>();
  for (const run of columns) for (const m of run) linedUp.set(m.i, m.col);
  const target = new Map<number, number>();

  // Columns of trailing comments: comments after code on consecutive lines, written at one column. A column moves
  // as one, as far right as its furthest member needs, so one line whose code now reaches into the two spaces
  // before its comment pushes the whole column out with it (round 11: fmt moved one comment of a column of five).
  const trailing: { start: number; line: number; col: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const gap = src.slice(toks[i].end, i + 1 < toks.length ? toks[i + 1].start : src.length);
    const nl = gap.indexOf("\n");
    if (nl < 0 && i + 1 < toks.length) continue;
    const c = commentIn(nl < 0 ? gap : gap.slice(0, nl));
    if (c) trailing.push({ start: toks[i].end, line: toks[i].line, col: columnOf(toks[i].end + c.at) });
  }
  /** The comment column each trailing comment belongs to, by where its line's code ends; only runs of two or more. */
  const commentRun = new Map<number, number>();
  for (let k = 0, run = 0; k < trailing.length; k++) {
    const prev = trailing[k - 1];
    if (!prev || prev.line + 1 !== trailing[k].line || prev.col !== trailing[k].col) run = k;
    commentRun.set(trailing[k].start, run);
  }
  const runSize = new Map<number, number>();
  for (const r of commentRun.values()) runSize.set(r, (runSize.get(r) ?? 0) + 1);
  for (const [start, r] of commentRun) if (runSize.get(r)! < 2) commentRun.delete(start);
  const commentTarget = new Map<number, number>();

  let printed = "";
  for (let pass = 0; pass < 16; pass++) {
    const placed = new Map<number, number>();
    const wanted = new Map<number, { want: number; at: number }>();
    printed = layout(placed, wanted);
    let settled = true;
    for (const run of columns) {
      const at = Math.max(...run.map((m) => placed.get(m.i)!));
      if (run.some((m) => placed.get(m.i) !== at)) { settled = false; for (const m of run) target.set(m.i, at); }
    }
    const runs = new Map<number, { want: number; at: number }[]>();
    for (const [start, w] of wanted) { const r = commentRun.get(start)!; runs.set(r, [...(runs.get(r) ?? []), w]); }
    for (const [r, ws] of runs) {
      const at = Math.max(...ws.map((w) => w.want));
      if (ws.some((w) => w.at !== at)) { settled = false; commentTarget.set(r, at); }
    }
    if (settled) break;
  }
  return printed;

  /**
   * The program laid out, each lined-up token at its column; `placed` gets the column each of them landed at, and
   * `wanted` the column each trailing comment of a column wanted on its own and the one it was printed at.
   */
  function layout(placed: Map<number, number>, wanted: Map<number, { want: number; at: number }>): string {
    const out: string[] = [];
    let line = "";
    /** Each earlier line of the statement: where its tokens were written and where they are now. */
    let statementLines: { was: number; now: number }[][] = [];
    /** Where each earlier line of the statement starts, as written and now, and the bracket it starts inside. */
    let lineStarts: { was: number; now: number; inside: number }[] = [];
    let lineInside = -1;
    let lineCols: { was: number; now: number }[] = [];
    let lineIndent = 0;
    /** How far the current line moved: its indentation now less the column its first token was written at. */
    let lineShift = 0;
    let statementIndent = 0;
    /** The column the statement's first token was written at: a continuation line is never lined up at or before it. */
    let statementWas = 0;
    let blockDepth = 0;
    /** The open brackets, each with its line's indentation now and as written, and which bracket it is. */
    const open: { indent: number; was: number; id: number }[] = [];
    // Whether the last thing emitted was a blank line, so a run of them is one.
    const blank = () => { if (out.length && out[out.length - 1] !== "") out.push(""); };

    /** The lines between two tokens: comments on their own, at `indent`, and blank lines, at most one in a row. */
    const between = (segments: string[], indent: number) => {
      let sawBlank = false;
      for (const seg of segments) {
        const c = commentIn(seg);
        if (!c) { sawBlank = true; continue; }
        if (sawBlank) blank();
        sawBlank = false;
        out.push(" ".repeat(indent) + c.text);
      }
      if (sawBlank) blank();
    };

    /**
     * End the line being built, with the comment written after its code, if any: at its column, moved with its line,
     * at least two spaces after the code, and with the rest of its column when it is in one.
     */
    const endLine = (tail: string, tailStart: number) => {
      const c = commentIn(tail);
      if (c) {
        const was = columnOf(tailStart + c.at) + lineShift;
        const want = Math.max(was, line.length + 2);
        const run = commentRun.get(tailStart);
        const at = run === undefined ? want : Math.max(want, commentTarget.get(run) ?? want);
        if (run !== undefined) wanted.set(tailStart, { want, at });
        line = line + " ".repeat(at - line.length) + c.text;
      }
      out.push(line.trimEnd());
    };

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const gapStart = i === 0 ? 0 : toks[i - 1].end;
      const gap = src.slice(gapStart, t.start);
      const text = src.slice(t.start, t.end);
      if (i > 0 && !gap.includes("\n")) {
        // A loop body on the brace's line starts its statement there.
        if (startsStatement[i]) { statementIndent = lineIndent; statementWas = columnOf(t.start); statementLines = []; lineStarts = []; lineCols = []; }
        const was = linedUp.get(i);
        const want = was === undefined ? undefined : target.get(i) ?? was + lineShift;
        line += want === undefined ? spacing(toks[i - 1], t, gap) : " ".repeat(Math.max(1, want - line.length));
        if (want !== undefined) placed.set(i, line.length);
        // Where a continuation line can be lined up: under an argument, an item, an entry, a value or the `=` before
        // it (`spots = a` over `      + b`), not under a comma or an operator.
        const prev = toks[i - 1];
        if (isOpener(prev) || isOp(prev, ",") || assignEq(prev) || assignEq(t)) lineCols.push({ was: columnOf(t.start), now: line.length });
        line += text;
      } else {
        const segments = gap.split("\n");
        if (i > 0) { endLine(segments[0], gapStart); segments.shift(); }
        segments.pop();
        const statement = startsStatement[i];
        if (!statement) { statementLines.push(lineCols); lineStarts.push({ was: lineIndent - lineShift, now: lineIndent, inside: lineInside }); }
        const inside = open.length ? open[open.length - 1].id : -1;
        let indent: number;
        if (isBlockClose(t)) indent = Math.max(0, blockDepth - 1) * 2;
        else if (statement) indent = blockDepth * 2;
        else if (isCloser(t) && open.length) indent = open[open.length - 1].indent;
        else {
          // Two in from the line that opened the bracket (or from the statement) is a hanging indent, kept as one;
          // anything else stays under the token of an earlier line it was written under, if there is one.
          const was = columnOf(t.start);
          const hang = (open.length ? open[open.length - 1].indent : statementIndent) + 2;
          const hangWas = (open.length ? open[open.length - 1].was : statementWas) + 2;
          let under: number | undefined;
          if (was !== hangWas && was > statementWas) for (let k = statementLines.length - 1; k >= 0 && under === undefined; k--) under = statementLines[k].find((c) => c.was === was)?.now;
          // Inside brackets, a line that carries an item on with an operator (`  box(1)` over `    | move(0, 1, 0)`)
          // stays two in from the line above it in the same brackets when it was written further in than that line,
          // rather than flat with the items. Outside them every line of the statement continues it, so it hangs.
          if (under === undefined && open.length && was !== hangWas && t.type === "op" && CARRIES.has(t.value) && t.role !== "unary") {
            let k = lineStarts.length - 1;
            while (k >= 0 && lineStarts[k].inside !== inside) k--;
            if (k >= 0 && was > lineStarts[k].was) under = lineStarts[k].now + 2;
          }
          indent = under ?? hang;
        }
        // A comment before a closing brace or bracket belongs inside it.
        const commentIndent = isBlockClose(t) ? blockDepth * 2 : isCloser(t) ? indent + 2 : indent;
        between(segments, commentIndent);
        if (statement) { statementIndent = indent; statementWas = columnOf(t.start); statementLines = []; lineStarts = []; }
        lineIndent = indent;
        lineInside = inside;
        lineShift = indent - columnOf(t.start);
        line = " ".repeat(indent) + text;
        lineCols = [{ was: columnOf(t.start), now: indent }];
      }
      if (isBlockOpen(t)) blockDepth++;
      else if (isBlockClose(t)) blockDepth = Math.max(0, blockDepth - 1);
      else if (isOpener(t)) open.push({ indent: lineIndent, was: lineIndent - lineShift, id: i });
      else if (isCloser(t)) open.pop();
    }
    const rest = src.slice(toks.length ? toks[toks.length - 1].end : 0).split("\n");
    if (toks.length) { endLine(rest[0], toks[toks.length - 1].end); rest.shift(); }
    between(rest, 0);
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.length ? out.join("\n") + "\n" : "";
  }
}

/**
 * Where a program differs from its layout, for `aixle fmt --check`: each line fmt would change, as it is and as
 * fmt writes it, the first `max` of them, and how many there are in all (round 11: "not formatted" with no line
 * cost a diff by hand). fmt never joins, splits or drops a line with something on it, so the lines with code or a
 * comment pair off in order, and the blank lines between them are compared as runs.
 */
export function formatDiff(source: string, formatted: string, max = 5): { count: number; lines: string[] } {
  // count: the lines that differ (every line, when they end in \r\n); lines: what to print about them.
  const crlf = /\r\n/.test(source);
  const split = (s: string) => { const l = s.split("\n"); if (l[l.length - 1] === "") l.pop(); return l; };
  const a = split(source.replace(/\r\n/g, "\n")), b = split(formatted);
  // Each place fmt would change, with how many lines it changes there.
  const found: { line: number; what: string[]; n: number }[] = [];
  const filled = (l: string[]) => l.map((t, i) => [t, i] as const).filter(([t]) => t.trim());
  const fa = filled(a), fb = filled(b);
  // A run of blank lines before each filled line (and after the last): what it was, and what fmt keeps of it.
  const blanks = (from: number, to: number, kept: number, end: boolean) => {
    const run = a.slice(from, to);
    if (!run.length) return;
    const why = run.length > kept ? (from === 0 ? `${run.length === 1 ? "a blank line" : `${run.length} blank lines`} at the start of the file; fmt drops ${run.length === 1 ? "it" : "them"}` : end ? `${run.length === 1 ? "a blank line" : `${run.length} blank lines`} at the end of the file; fmt drops ${run.length === 1 ? "it" : "them"}` : `${run.length} blank lines in a row; fmt keeps one`) : run.some((t) => t !== "") ? "a blank line holds spaces; fmt empties it" : undefined;
    if (why) found.push({ line: from + 1, what: [`line ${from + 1}: ${why}`], n: run.length > kept ? run.length - kept : run.filter((t) => t !== "").length });
  };
  for (let k = 0; k < fa.length; k++) {
    const [was, i] = fa[k];
    const prevA = k ? fa[k - 1][1] + 1 : 0, prevB = k ? fb[k - 1][1] + 1 : 0;
    blanks(prevA, i, fb[k] ? fb[k][1] - prevB : 0, false);
    const now = fb[k]?.[0] ?? "";
    if (was === now) continue;
    // A long line is shown from a little before where the two first differ, the same stretch of each.
    let d = 0;
    while (d < was.length && was[d] === now[d]) d++;
    const from = Math.max(...[was.length, now.length]) > 110 ? Math.max(0, d - 40) : 0;
    const cut = (t: string) => `"${from ? "..." : ""}${t.slice(from, from + 100)}${t.length > from + 100 ? "..." : ""}"`;
    const w = Math.max(`line ${i + 1} is:`.length, "fmt writes:".length);
    found.push({ line: i + 1, what: [`${`line ${i + 1} is:`.padEnd(w)} ${cut(was)}`, `${"fmt writes:".padEnd(w)} ${cut(now)}`], n: 1 });
  }
  if (fa.length) blanks(fa[fa.length - 1][1] + 1, a.length, 0, true);
  else blanks(0, a.length, 0, false);
  if (source.length && !source.endsWith("\n") && a.length) found.push({ line: a.length, what: [`line ${a.length}: no line break after it; fmt ends the file with one`], n: 1 });
  const notes: string[] = [];
  if (crlf) notes.push("its lines end in \\r\\n; fmt writes \\n");
  const count = crlf ? a.length : found.reduce((t, f) => t + f.n, 0);
  const lines = [...notes, ...found.slice(0, max).flatMap((f) => f.what)];
  if (found.length > max) lines.push(`... and ${found.length - max} more`);
  return { count, lines };
}
