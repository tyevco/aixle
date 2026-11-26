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
 *     padded into the same column as the line above or below keeps that column.
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
 *     argument lined up with the first stays lined up); anything else becomes
 *     a hanging indent;
 *   - blank lines: one where the author had one or more, none at the start
 *     or the end of the file;
 *   - a comment on its own line takes the indentation of the line it
 *     precedes (inside the brackets or the loop when that line closes them);
 *     a comment after code keeps its column, moved with its line's
 *     indentation, so a column of them stays a column, unless the code now
 *     reaches it, when it sits two spaces after the code. A comment's text
 *     is kept as written.
 */
import { parseTokens } from "./parser.js";
import type { Token } from "./lexer.js";

const KEYWORDS = new Set(["def", "for", "in", "show", "scene", "set", "use", "assert"]);

const isOp = (t: Token, v: string): boolean => t.type === "op" && t.value === v;
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
  const src = source.replace(/\r\n?/g, "\n");
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
  // Where each line lined things up: the column of an assignment's or a def's `=`, and of a value after a record's
  // `:`, so a run of lines that share one keeps it.
  const columns = new Map<string, number>();
  const assignEq = (t: Token) => isOp(t, "=") && t.role === undefined;
  toks.forEach((t, i) => {
    if (assignEq(t)) columns.set(`=${t.line}`, columnOf(t.start));
    else if (i > 0 && isOp(toks[i - 1], ":") && t.line === toks[i - 1].line) columns.set(`:${t.line}`, columnOf(t.start));
  });
  const linedUp = (kind: string, t: Token): boolean => {
    const was = columnOf(t.start);
    return columns.get(`${kind}${t.line - 1}`) === was || columns.get(`${kind}${t.line + 1}`) === was;
  };

  const out: string[] = [];
  let line = "";
  /** Each earlier line of the statement: where its tokens were written and where they are now. */
  let statementLines: { was: number; now: number }[][] = [];
  let lineCols: { was: number; now: number }[] = [];
  let lineIndent = 0;
  /** How far the current line moved: its indentation now less the column its first token was written at. */
  let lineShift = 0;
  let statementIndent = 0;
  /** The column the statement's first token was written at: a continuation line is never lined up at or before it. */
  let statementWas = 0;
  let blockDepth = 0;
  /** The open brackets, each with its line's indentation now and as written. */
  const open: { indent: number; was: number }[] = [];
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

  /** End the line being built, with the comment written after its code, if any. */
  const endLine = (tail: string, tailStart: number) => {
    const c = commentIn(tail);
    if (c) {
      const was = columnOf(tailStart + c.at) + lineShift;
      const at = was >= line.length + 2 ? was : line.length + 2;
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
      if (startsStatement[i]) { statementIndent = lineIndent; statementWas = columnOf(t.start); statementLines = []; lineCols = []; }
      let sp = spacing(toks[i - 1], t, gap);
      const kind = assignEq(t) ? "=" : isOp(toks[i - 1], ":") ? ":" : undefined;
      if (kind && gap.length > 1 && linedUp(kind, t)) sp = " ".repeat(Math.max(1, columnOf(t.start) + lineShift - line.length));
      line += sp;
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
      if (!statement) statementLines.push(lineCols);
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
        indent = under ?? hang;
      }
      // A comment before a closing brace or bracket belongs inside it.
      const commentIndent = isBlockClose(t) ? blockDepth * 2 : isCloser(t) ? indent + 2 : indent;
      between(segments, commentIndent);
      if (statement) { statementIndent = indent; statementWas = columnOf(t.start); statementLines = []; }
      lineIndent = indent;
      lineShift = indent - columnOf(t.start);
      line = " ".repeat(indent) + text;
      lineCols = [{ was: columnOf(t.start), now: indent }];
    }
    if (isBlockOpen(t)) blockDepth++;
    else if (isBlockClose(t)) blockDepth = Math.max(0, blockDepth - 1);
    else if (isOpener(t)) open.push({ indent: lineIndent, was: lineIndent - lineShift });
    else if (isCloser(t)) open.pop();
  }
  const rest = src.slice(toks.length ? toks[toks.length - 1].end : 0).split("\n");
  if (toks.length) { endLine(rest[0], toks[toks.length - 1].end); rest.shift(); }
  between(rest, 0);
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.length ? out.join("\n") + "\n" : "";
}
