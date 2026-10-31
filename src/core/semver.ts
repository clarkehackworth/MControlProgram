/**
 * Minimal semver range check for plugin dependencies.
 * Supports: `*`, `1.2.3` (exact), `^1.2.3`, `~1.2.3`, `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3`,
 * space-separated (AND) and `||` (OR). Prerelease tags are ignored.
 * ponytail: no x-ranges or hyphen ranges; pull in `semver` if plugins need them
 */
const parse = (v: string) => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) throw new Error(`invalid version "${v}"`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] as const;
};
const cmp = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

function one(v: readonly number[], c: string): boolean {
  if (c === '*' || c === '') return true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(c)!;
  const r = parse(m[2]!);
  switch (m[1]) {
    case '>=': return cmp(v, r) >= 0;
    case '<=': return cmp(v, r) <= 0;
    case '>': return cmp(v, r) > 0;
    case '<': return cmp(v, r) < 0;
    case '~': return cmp(v, r) >= 0 && v[0] === r[0] && v[1] === r[1];
    case '^': return cmp(v, r) >= 0 && (r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : cmp(v, r) === 0);
    default: return cmp(v, r) === 0;
  }
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return range.split('||').some((alt) => alt.trim().split(/\s+/).every((c) => one(v, c)));
}
