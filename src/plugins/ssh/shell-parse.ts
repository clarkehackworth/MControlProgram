/**
 * Turn a POSIX shell command line into what it would run, for the ssh command rules, using tree-sitter-bash
 * (WASM, no native build). Output: every command anywhere in the line (pipelines, lists, subshells,
 * if/while/for bodies, functions, $( ) and backticks), commands run through wrappers (sudo, env, xargs,
 * timeout…, find -exec, sh/bash -c "…", su -c, ssh host "…") parsed recursively, and output-redirect targets.
 * Anything whose effect can't be known statically (a program name or -c script built from $VARs or $( ),
 * syntax errors) is reported in `unknown`, so deny-by-default can fail closed on it.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, type Node } from 'web-tree-sitter';

export interface Cmd { program: string; args: string[]; text: string; nested: boolean }
export interface Analysis { commands: Cmd[]; writes: string[]; unknown: string[] }

const req = createRequire(import.meta.url);
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(path.join(path.dirname(req.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm')));

/** Short flags that take a value, per wrapper (`sudo -u root rm`). ponytail: `--long value` isn't recognised. */
const WRAP: Record<string, string> = { sudo: 'ughpCDRTUrt', doas: 'uC', env: 'uCSP', nice: 'n', timeout: 'sk', ionice: 'cnp', xargs: 'InPdLsEa', stdbuf: 'ioe', watch: 'nd',
  nohup: '', time: '', exec: 'a', command: '', builtin: '', chroot: '', unbuffer: '', nsenter: 'tSG', flock: 'w', setsid: '', taskset: '', chrt: '', caffeinate: '' };
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox']);
const SSH_ARG = 'BbcDEeFIiJLlmOoPpQRSWw';
const SAFE_WRITES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const base = (p: string) => p.replace(/^.*\//, '') || p;

/** A word's value if it is static (no $VAR, $( ), globs are kept as text), else undefined. */
function value(n: Node): string | undefined {
  switch (n.type) {
    case 'word': case 'number': return n.text.replace(/\\(.)/gs, '$1');
    case 'raw_string': return n.text.slice(1, -1);
    case 'ansi_c_string': return n.text.slice(2, -1);
    case 'string': {
      let s = '';
      for (const c of n.namedChildren) { if (!c) continue; if (c.type !== 'string_content') return undefined; s += c.text; }
      return n.namedChildren.length ? s.replace(/\\([$`"\\\n])/g, '$1') : n.text.slice(1, -1);
    }
    case 'concatenation': { let s = ''; for (const c of n.namedChildren) { const v = c && value(c); if (v === undefined) return undefined; s += v; } return s; }
    case 'command_name': return n.firstNamedChild ? value(n.firstNamedChild) : undefined;
    default: return undefined;
  }
}

export function analyze(line: string, depth = 0): Analysis {
  const out: Analysis = { commands: [], writes: [], unknown: [] };
  if (depth > 4) { out.unknown.push('nested too deeply'); return out; }
  // tree-sitter-bash ends the command at an escaped `\;` (find -exec … \;); the quoted form parses right.
  // ponytail: also rewrites a literal \; inside double quotes, which only changes the analysed text
  const tree = parser.parse(line.replace(/(^|[^\\])\\;/g, "$1';'"));
  if (!tree) { out.unknown.push('could not parse'); return out; }
  const merge = (a: Analysis) => { out.commands.push(...a.commands.map((c) => ({ ...c, nested: true }))); out.writes.push(...a.writes); out.unknown.push(...a.unknown); };

  /** A command given as words (after a wrapper): record it and follow further wrappers. */
  const words = (w: { v?: string; raw: string }[], nested: boolean): void => {
    const name = w[0];
    if (!name) return;
    if (name.v === undefined) { out.unknown.push(`program name is computed: ${name.raw}`); return; }
    const program = base(name.v);
    const args = w.slice(1).map((x) => x.v ?? x.raw);
    out.commands.push({ program, args, text: [program, ...args].join(' '), nested });
    const rest = w.slice(1);
    const script = (s: { v?: string; raw: string } | undefined, what: string) => {
      if (!s) return;
      if (s.v !== undefined) return merge(analyze(s.v, depth + 1));
      // $VAR / $( ) inside: still check the visible commands, but the expansion could add more
      out.unknown.push(`${what} script uses variables or substitutions: ${s.raw}`);
      merge(analyze(/^".*"$/s.test(s.raw) ? s.raw.slice(1, -1) : s.raw, depth + 1));
    };
    if (program === 'command' && rest.some((x) => x.v === '-v' || x.v === '-V')) return; // lookup only, runs nothing
    if (WRAP[program] !== undefined) {
      let i = 0; let pos = 0;
      for (; i < rest.length; i++) {
        const x = rest[i]!.v ?? '';
        if (x.startsWith('-') && x !== '-') { if (x.length === 2 && WRAP[program]!.includes(x[1]!)) i++; continue; }
        if (program === 'env' && x.includes('=')) continue;
        if (pos++ === 0 && ((program === 'timeout' && /^\d/.test(x)) || program === 'chroot' || program === 'flock' || program === 'taskset' || program === 'chrt')) continue;
        break;
      }
      return words(rest.slice(i), true);
    }
    if (program === 'find') {
      for (let i = 0; i < rest.length; i++) if (['-exec', '-execdir', '-ok', '-okdir'].includes(rest[i]!.v ?? '')) {
        const end = rest.findIndex((x, j) => j > i && (x.v === ';' || x.v === '+'));
        words(rest.slice(i + 1, end < 0 ? undefined : end), true);
      }
      return;
    }
    if (SHELLS.has(program) || program === 'su') {
      const c = rest.findIndex((x) => /^-[a-z]*c[a-z]*$/.test(x.v ?? '') || x.v === '--command');
      if (c >= 0) return script(rest[c + 1], program);
      if (program === 'su' || rest.some((x) => x.v === '--version' || x.v === '--help')) return;
      const file = rest.find((x) => !(x.v ?? '').startsWith('-'));
      out.unknown.push(file ? `${program} runs script file ${file.raw}` : `${program} reads commands from its input`);
      return;
    }
    if (program === 'ssh') {
      let i = 0;
      for (; i < rest.length; i++) { const x = rest[i]!.v ?? ''; if (!x.startsWith('-')) break; if (x.length === 2 && SSH_ARG.includes(x[1]!)) i++; }
      const remote = rest.slice(i + 1);
      if (remote.length) remote.every((x) => x.v !== undefined) ? merge(analyze(remote.map((x) => x.v).join(' '), depth + 1)) : out.unknown.push('ssh remote command is computed');
      return;
    }
    if (program === 'eval' && rest.length) script({ v: rest.every((x) => x.v !== undefined) ? rest.map((x) => x.v).join(' ') : undefined, raw: rest.map((x) => x.raw).join(' ') }, 'eval');
  };

  const visit = (n: Node) => {
    if (n.type === 'ERROR' || n.isMissing) out.unknown.push(`syntax error near: ${n.text.slice(0, 40)}`);
    if (n.type === 'command') {
      const name = n.childForFieldName('name');
      const args = n.childrenForFieldName('argument').filter((x): x is Node => !!x);
      if (name) words([{ v: value(name), raw: name.text }, ...args.map((a) => ({ v: value(a), raw: a.text }))], false);
    }
    if (n.type === 'file_redirect') {
      const op = n.children.find((c) => c && !c.isNamed)?.text ?? '';
      const dest = n.childForFieldName('destination');
      if (dest && /^(>|>>|>\||&>|&>>|>&)$/.test(op) && !(op === '>&' && dest.type === 'number')) {
        const v = value(dest);
        if (v === undefined) out.unknown.push(`output file is computed: ${dest.text}`);
        else if (!SAFE_WRITES.has(v)) out.writes.push(v);
      }
    }
    for (const c of n.children) if (c) visit(c);
  };
  visit(tree.rootNode);
  tree.delete();
  return out;
}
