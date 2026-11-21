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

/** Short flags that take a value, per wrapper (`sudo -u root rm`), alone, clustered (`-nu root`) or glued (`-uroot`). */
const WRAP: Record<string, string> = { sudo: 'ughpCDRTUrt', doas: 'uC', env: 'uCSPa', nice: 'n', timeout: 'sk', ionice: 'cnpPu', xargs: 'InPdLsEa', stdbuf: 'ioe', watch: 'nq',
  nohup: '', time: 'fo', exec: 'a', command: '', builtin: '', chroot: '', unbuffer: '', nsenter: 'tSG', flock: 'wEc', setsid: '', taskset: '', chrt: 'TPD', caffeinate: 'tw' };
/**
 * Long flags per wrapper; `name=` takes a value in the next word (optional-value flags only take `--flag=value`,
 * so they are listed bare). Unique prefixes count, as getopt accepts them. A long flag that isn't listed makes the
 * line unknown: guessing wrong either way would hide the real program from the rules.
 */
const WRAP_LONG: Record<string, string> = {
  sudo: 'close-from= chdir= group= host= prompt= chroot= role= type= command-timeout= other-user= user= preserve-env askpass background bell set-home login shell non-interactive preserve-groups stdin no-update reset-timestamp',
  env: 'unset= chdir= split-string= argv0= ignore-environment null debug block-signal default-signal ignore-signal list-signal-handling',
  nice: 'adjustment=', timeout: 'signal= kill-after= foreground preserve-status verbose', ionice: 'class= classdata= pid= pgid= uid= ignore',
  xargs: 'arg-file= delimiter= max-args= max-chars= max-procs= process-slot-var= eof replace max-lines interactive no-run-if-empty null open-tty exit show-limits verbose',
  stdbuf: 'input= output= error=', watch: 'interval= equexit= differences precise no-title beep errexit chgexit color exec no-wrap no-linewrap',
  time: 'format= output= append verbose portability quiet', chroot: 'groups= userspec= skip-chdir',
  nsenter: 'target= setuid= setgid= mount uts ipc net pid user cgroup time root wd wdns preserve-credentials all follow-context no-fork',
  flock: 'wait= timeout= conflict-exit-code= command= shared exclusive unlock nonblock nb close no-fork verbose', setsid: 'ctty fork wait',
  taskset: 'all-tasks pid cpu-list', chrt: 'sched-runtime= sched-period= sched-deadline= batch deadline fifo idle other rr reset-on-fork all-tasks max pid verbose' };
function longFlag(program: string, name: string): { name: string; takes: boolean } | undefined {
  const all = [...(WRAP_LONG[program] ?? '').split(' ').filter(Boolean), 'help', 'version'];
  const hit = all.filter((f) => f === name || f === name + '=');
  const hits = hit.length ? hit : all.filter((f) => f.startsWith(name));
  const takes = hits.map((f) => f.endsWith('='));
  return hits.length && takes.every((t) => t === takes[0]) ? { name: hits[0]!.replace(/=$/, ''), takes: takes[0]! } : undefined;
}
/**
 * Programs whose arguments (or input) are code in another language, which these rules can't read: running one is
 * always unknown. ponytail: a name list; any other allowed program that takes code (sed's `e`, vim -c, …) isn't caught.
 */
const INTERP = /^(python|pypy|perl|ruby|php|node|nodejs|deno|bun|lua|luajit|tclsh|wish|expect|Rscript|osascript|irb|jshell|groovy|pwsh|powershell)[\d.]*$/;
/** awk is mostly harmless text processing; only these can run a command or write a file from inside the script. */
const AWK_RUNS = /system|getline|[|>@]|^-[fEil]|^--(file|exec|include|load)/;
/** Programs whose arguments name a file they write. ponytail: the usual copiers only; touch, mkdir, chmod, rm… are still judged by program name. */
const WRITERS = new Set(['cp', 'mv', 'install', 'ln', 'tee', 'dd', 'scp', 'rsync']);
const TARGET_FLAG = new Set(['cp', 'mv', 'install', 'ln']); // -t DIR / --target-directory
const SED_LONG = ['expression', 'file', 'in-place', 'line-length', 'null-data', 'zero-terminated', 'quiet', 'silent', 'regexp-extended', 'separate', 'unbuffered', 'posix', 'debug', 'follow-symlinks', 'sandbox', 'help', 'version'];
/** Does a sed script use `e` (run a command) or `w`/`W` (write a file), as a command or an s///flag? Anything it can't follow counts as yes. */
export function sedRuns(s: string): boolean {
  let i = 0;
  const skip = (d: string, brackets: boolean): boolean => { // from just past an opening delimiter to just past its closing one
    for (; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (brackets && s[i] === '[') { const e = s.indexOf(']', i + (s[i + 1] === '^' ? 3 : 2)); if (e < 0) return false; i = e; continue; }
      if (s[i] === d) { i++; return true; }
    }
    return false;
  };
  const flags = () => { while (s[i] === 'I' || s[i] === 'M') i++; };
  while (i < s.length) {
    const c = s[i]!;
    if (/[\s;{}\d$,~+!]/.test(c)) { i++; continue; } // separators and the simple parts of an address
    if (c === '/') { i++; if (!skip('/', true)) return true; flags(); continue; }
    if (c === '\\') { const d = s[i + 1]; i += 2; if (d === undefined || !skip(d, true)) return true; flags(); continue; }
    i++;
    if (c === 's' || c === 'y') {
      const d = s[i++];
      if (d === undefined || !skip(d, c === 's') || !skip(d, false)) return true;
      if (c === 's') { const f = /^[a-zA-Z0-9]*/.exec(s.slice(i))![0]; if (/[ew]/.test(f)) return true; i += f.length; }
    } else if ('aicrR#'.includes(c)) { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; } // text or a file name to end of line
    else if (':btT'.includes(c)) { const e = s.slice(i).search(/[;\n]/); i = e < 0 ? s.length : i + e; } // a label
    else if (!'dDgGhHnNpPxzFqQlL='.includes(c)) return true; // e, w, W, or something unexpected
  }
  return false;
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox', 'fish', 'csh', 'tcsh']);
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
  // Quoted strings and other escapes are matched first so they pass through untouched.
  const tree = parser.parse(line.replace(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\([\s\S])/g, (m, c) => (c === ';' ? "';'" : m)));
  if (!tree) { out.unknown.push('could not parse'); return out; }
  // `..` is resolved so /tmp/../etc/x is a write to /etc. ponytail: lexical; relative paths and symlinks stay as written
  const wr = (v: string) => { const f = v.startsWith('/') ? path.posix.normalize(v) : v; if (!SAFE_WRITES.has(f)) out.writes.push(f); };
  const merge = (a: Analysis) => { out.commands.push(...a.commands.map((c) => ({ ...c, nested: true }))); out.writes.push(...a.writes); out.unknown.push(...a.unknown); };

  type W = { v?: string; raw: string };
  /** Files a program writes because of its arguments (cp a /etc/b), so write rules see them like a redirect. */
  const argWrites = (program: string, rest: W[]): void => {
    const dest = (x: W | undefined, remote = false) => { if (!x) return; if (x.v === undefined) out.unknown.push(`output file is computed: ${x.raw}`); else wr(remote ? x.v.replace(/^[^/]+:/, '') : x.v); };
    if (program === 'dd') { for (const x of rest) if ((x.v ?? x.raw).startsWith('of=')) dest(x.v === undefined ? x : { v: x.v.slice(3), raw: x.raw }); return; }
    const pos: (W & { afterFlag: boolean })[] = []; const targets: (W | undefined)[] = [];
    let dd = false; let afterFlag = false; let dirs = false;
    for (let j = 0; j < rest.length; j++) {
      const x = rest[j]!; const v = x.v ?? '';
      if (!dd && v === '--') { dd = true; continue; }
      if (!dd && v.startsWith('-') && v !== '-') {
        const long = /^--(t[a-z-]*)(?:=(.*))?$/.exec(v);
        const t = TARGET_FLAG.has(program) ? (long && 'target-directory'.startsWith(long[1]!) ? long : /^-[a-su-zA-Z]*t(.*)$/.exec(v)) : null;
        if (t) targets.push(t.at(-1) ? { v: t.at(-1)!, raw: v } : rest[++j]);
        if (program === 'install' && (/^-[a-zA-Z]*d/.test(v) || v === '--directory')) dirs = true;
        afterFlag = true; continue;
      }
      pos.push({ ...x, afterFlag }); afterFlag = false;
    }
    const remote = program === 'scp' || program === 'rsync';
    if (program === 'tee' || dirs) return pos.forEach((x) => dest(x));
    if (targets.length) return targets.forEach((x) => dest(x));
    // the destination is the last word; if a flag sits right before it, that word may be the flag's value, so count the one before too
    const last = pos.at(-1);
    dest(last, remote);
    if (last?.afterFlag) dest(pos.at(-2), remote);
  };
  /** sed: `e` and `w` in the script run commands and write files; -i rewrites the files it is given. */
  const sed = (rest: W[]): void => {
    const scripts: string[] = []; const files: string[] = []; let inplace = false; let sandbox = false; let dd = false;
    const bad = (why: string) => { out.unknown.push(`sed ${why}`); };
    for (let j = 0; j < rest.length; j++) {
      const v = rest[j]!.v;
      if (v === undefined) return bad('arguments are computed');
      if (!dd && v === '--') { dd = true; continue; }
      if (!dd && v.startsWith('--')) {
        const [, name, val] = /^--([^=]*)(?:=(.*))?$/s.exec(v)!;
        const hits = SED_LONG.includes(name!) ? [name!] : SED_LONG.filter((f) => f.startsWith(name!));
        if (hits.length !== 1) return bad(`option is not recognised: ${v}`);
        if (hits[0] === 'file') return bad('runs a script file');
        if (hits[0] === 'sandbox') sandbox = true;
        if (hits[0] === 'in-place') inplace = true;
        if (hits[0] === 'line-length' && val === undefined) j++;
        if (hits[0] === 'expression') { const e = val ?? rest[++j]?.v; if (e === undefined) return bad('script is computed'); scripts.push(e); }
        continue;
      }
      if (!dd && v.startsWith('-') && v !== '-') {
        for (let k = 1; k < v.length; k++) {
          const ch = v[k]!;
          if ('nrEsuz'.includes(ch)) continue;
          if (ch === 'i') { inplace = true; break; } // the rest of the word is the backup suffix
          if (ch === 'l') { if (k === v.length - 1) j++; break; }
          if (ch === 'e') { const e = v.slice(k + 1) || rest[++j]?.v; if (e === undefined) return bad('script is computed'); scripts.push(e); break; }
          return bad(ch === 'f' ? 'runs a script file' : `option is not recognised: ${v}`);
        }
        continue;
      }
      files.push(v);
    }
    if (!scripts.length && files.length) scripts.push(files.shift()!);
    if (!sandbox && scripts.some(sedRuns)) bad('script may run commands or write files');
    if (inplace) files.forEach(wr);
  };

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
    if (program === 'command') { // -v/-V before the name is a lookup and runs nothing; after it (`command rm -v x`) it is rm's own flag
      const lead = rest.findIndex((x) => !(x.v ?? '').startsWith('-'));
      if (rest.slice(0, lead < 0 ? rest.length : lead).some((x) => /^-[pvV]*[vV][pvV]*$/.test(x.v!))) return;
    }
    if (WRITERS.has(program)) argWrites(program, rest);
    if (program === 'sed') return sed(rest);
    if (INTERP.test(program)) {
      if (!rest.length || !rest.every((x) => /^(-V|--version|--help)$/.test(x.v ?? ''))) out.unknown.push(`${program} runs code these rules cannot read`);
      return;
    }
    if (/^[gmn]?awk$/.test(program)) {
      if (rest.some((x) => x.v === undefined || AWK_RUNS.test(x.v))) out.unknown.push(`${program} script may run commands or write files`);
      return;
    }
    if (WRAP[program] !== undefined) {
      let i = 0; let pos = 0; let dd = false;
      // a flag whose value is itself a command line: env -S "rm x" (re-read as env's own arguments), flock -c "rm x"
      const runs = (flag: string, val: { v?: string; raw: string } | undefined, tail: { raw: string }[]): boolean => {
        if (program === 'flock' && (flag === 'c' || flag === 'command')) { script(val, 'flock'); return true; }
        if (program !== 'env' || (flag !== 'S' && flag !== 'split-string')) return false;
        if (val?.v === undefined) out.unknown.push('env -S command is computed');
        else merge(analyze(['env', val.v, ...tail.map((t) => t.raw)].join(' '), depth + 1));
        return true;
      };
      for (; i < rest.length; i++) {
        const x = rest[i]!.v ?? '';
        if (!dd && x === '--') { dd = true; continue; }
        if (!dd && x.startsWith('--')) {
          const eq = x.indexOf('=');
          const f = longFlag(program, x.slice(2, eq < 0 ? undefined : eq));
          if (!f) { out.unknown.push(`${program} option is not recognised: ${x}`); return; }
          if (eq >= 0) { if (runs(f.name, { v: x.slice(eq + 1), raw: x.slice(eq + 1) }, rest.slice(i + 1))) return; continue; }
          if (!f.takes) continue;
          if (runs(f.name, rest[i + 1], rest.slice(i + 2))) return;
          i++; continue;
        }
        if (!dd && x.startsWith('-') && x !== '-') {
          const k = [...x].findIndex((ch, j) => j > 0 && WRAP[program]!.includes(ch)); // first value-taking flag in the cluster
          if (k < 0) continue;
          const glued = x.slice(k + 1);
          if (glued ? runs(x[k]!, { v: glued, raw: glued }, rest.slice(i + 1)) : runs(x[k]!, rest[i + 1], rest.slice(i + 2))) return;
          if (!glued) i++;
          continue;
        }
        if (program === 'env' && x.includes('=')) continue;
        if (pos++ === 0 && ((program === 'timeout' && /^\d/.test(x)) || program === 'chroot' || program === 'flock' || program === 'taskset' || program === 'chrt')) continue;
        break;
      }
      const cmd = rest.slice(i);
      // watch hands its arguments to `sh -c` as one line
      if (program === 'watch') return script({ v: cmd.every((c) => c.v !== undefined) ? cmd.map((c) => c.v).join(' ') : undefined, raw: cmd.map((c) => c.raw).join(' ') }, 'watch');
      return words(cmd, true);
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
      let i = 0; let host = false;
      for (; i < rest.length; i++) { // ssh [options] host [options] [--] command
        const x = rest[i]!.v ?? '';
        if (x === '--') { i += host ? 1 : 2; break; }
        if (x.startsWith('-') && x.length > 1) { if ([...x].findIndex((ch, j) => j > 0 && SSH_ARG.includes(ch)) === x.length - 1) i++; continue; }
        if (host) break;
        host = true;
      }
      const remote = rest.slice(i);
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
        else wr(v);
      }
    }
    for (const c of n.children) if (c) visit(c);
  };
  visit(tree.rootNode);
  tree.delete();
  return out;
}
