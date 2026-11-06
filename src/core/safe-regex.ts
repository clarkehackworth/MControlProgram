/**
 * Admin-authored regexes run against agent-controlled text on the single event loop, so a catastrophic
 * pattern would stall every MCP server. Reject the classic cause: a quantified group that contains an
 * unbounded quantifier, e.g. (a+)+  (.*a){9}  (\w+\s?)*
 * ponytail: heuristic, misses overlapping alternation like (a|a)*; use the `re2` package if that matters.
 */
/** True if a group that contains an unbounded quantifier (at any depth) is itself repeated unboundedly. */
function nested(src: string): boolean {
  const stack: boolean[] = []; let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') stack.push(false);
    else if (c === ')') {
      const had = stack.pop() ?? false; const rest = src.slice(i + 1);
      const rep = /^(?:[+*]|\{\d+,\d*\})/.test(rest);
      if (rep && had) return true;
      if (stack.length && (had || rep)) stack[stack.length - 1] = true;
    } else if (stack.length && (c === '+' || c === '*' || (c === '{' && /^\{\d+,\d*\}/.test(src.slice(i))))) stack[stack.length - 1] = true;
  }
  return false;
}

export function safeRegex(src: string, flags?: string): RegExp {
  if (nested(src)) throw new Error(`regex "${src}" has a quantifier nested inside a quantified group (catastrophic backtracking risk); rewrite it`);
  return new RegExp(src, flags);
}

if (process.argv[1]?.endsWith('safe-regex.ts')) {
  for (const bad of ['(a+)+$', '(.*a){9,}', '(\\w+\\s?)*', '((a*)b)+']) { let t = false; try { safeRegex(bad); } catch { t = true; } if (!t) throw new Error(`should reject ${bad}`); }
  for (const ok of ['^rm\\s+-rf', '(foo|bar)+', 'https?://[^/]+/admin', '(\\d{1,3}\\.){3}\\d+']) safeRegex(ok);
  console.log('ok');
}
