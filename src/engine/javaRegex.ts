/**
 * Convert Java-regex patterns (as used by LuaJ plugins via regex_match/regex_replace)
 * into JavaScript RegExp. Covers the constructs actually used in the plugin corpus:
 * inline flags (?i) (?m) (?s) combos, \p{Z}, \A, \z.
 */
export function javaRegexToJs(pattern: string): { source: string; flags: string } {
  let flags = "";
  let source = pattern;

  // Hoist leading/anywhere inline flag groups: (?im), (?is), (?i) ...
  source = source.replace(/\(\?([a-zA-Z]+)\)/g, (_m, chars: string) => {
    for (const c of chars) {
      if (c === "i" || c === "s" || c === "m") flags += c;
      // d/u/x have no direct JS equivalent or are default; ignore
    }
    return "";
  });

  // \A → ^ (string start; JS ^ is same without m flag)
  source = source.replace(/\\A/g, "^");
  // \z / \Z → $ (Java \Z allows trailing newline; close enough)
  source = source.replace(/\\[zZ]/g, "$");

  // \p{Z} (separators) → \s ; other \p{...} categories pass through and force u flag
  if (/\\[pP]\{/.test(source)) {
    source = source.replace(/\\p\{Z\}/g, "\\s");
    if (/\\[pP]\{/.test(source)) flags += "u";
  }

  return { source, flags: [...new Set(flags)].join("") };
}

export function compileJavaRegex(pattern: string): RegExp | null {
  try {
    const { source, flags } = javaRegexToJs(pattern);
    return new RegExp(source, flags + "g");
  } catch {
    return null;
  }
}
