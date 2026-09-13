/**
 * Tokens for .aix. Newlines end statements except inside parentheses or
 * brackets, so a long call can wrap. Comments start with `#` or `//`.
 */

export type TokenType = "num" | "str" | "ident" | "op" | "newline" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
}

export class SyntaxError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = "SyntaxError";
  }
}

const OPS = ["==", "!=", "<=", ">=", "..", "(", ")", "{", "}", "[", "]", ",", "=", "+", "-", "*", "/", "%", "^", "|", "&", "<", ">", ":", "."];

/** Operators that carry a statement over a line break when a line ends with one of them. */
const TRAILING = new Set(["=", "+", "-", "*", "/", "%", "^", "|", "&", ","]);
/** Operators that continue the previous line when a line starts with one of them. */
const LEADING = new Set(["+", "-", "*", "/", "|", "&"]);

/**
 * A line break does not end the statement when the line ends with an
 * operator or `=`, or the next non-blank, non-comment line starts with one:
 * both ways of wrapping a long pipeline read naturally.
 */
function continues(tokens: Token[], source: string, at: number): boolean {
  const last = tokens[tokens.length - 1];
  if (last && last.type === "op" && TRAILING.has(last.value)) return true;
  if (!last || last.type === "newline") return false;
  // Look at the next line only; comment lines are skipped, a blank line ends the statement.
  let j = at + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === " " || c === "\t" || c === "\r") { j++; continue; }
    if (c === "\n") return false;
    if (c === "#" || (c === "/" && source[j + 1] === "/")) {
      while (j < source.length && source[j] !== "\n") j++;
      j++;
      continue;
    }
    break;
  }
  if (j >= source.length) return false;
  return LEADING.has(source[j]) && source.slice(j, j + 2) !== "//";
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, depth = 0;
  const push = (type: TokenType, value: string) => tokens.push({ type, value, line });
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") {
      if (depth === 0 && !continues(tokens, source, i)) push("newline", "\n");
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (ch === "#" || (ch === "/" && source[i + 1] === "/")) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1, text = "";
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\n") throw new SyntaxError("unterminated string", line);
        text += source[j++];
      }
      if (j >= source.length) throw new SyntaxError("unterminated string", line);
      push("str", text);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?|^[0-9]+\.?/.exec(source.slice(i));
      if (!m) throw new SyntaxError(`bad number at '${source.slice(i, i + 8)}'`, line);
      push("num", m[0]);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      push("ident", m[0]);
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => source.startsWith(o, i));
    if (op) {
      if (op === "(" || op === "[") depth++;
      if (op === ")" || op === "]") depth = Math.max(0, depth - 1);
      push("op", op);
      i += op.length;
      continue;
    }
    throw new SyntaxError(`unexpected character '${ch}'`, line);
  }
  push("newline", "\n");
  push("eof", "");
  return tokens;
}
