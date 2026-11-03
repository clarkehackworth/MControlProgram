/**
 * "Native" ssh host: the same exec / shell / sftp surface as an ssh2 Client, backed by this machine
 * (the one MControlProgram runs on). index.ts only uses these few methods, so nothing else needs to know.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

class Chan extends EventEmitter {
  stderr = new EventEmitter();
  constructor(private p: ReturnType<typeof spawn>) {
    super();
    p.stdout!.on('data', (d) => this.emit('data', d));
    p.stderr!.on('data', (d) => this.stderr.emit('data', d));
    p.on('close', (code, sig) => this.emit('close', code, sig ?? undefined));
    p.on('error', (e) => { this.stderr.emit('data', Buffer.from(String(e.message))); this.emit('close', 127); });
  }
  write(s: string) { return this.p.stdin!.write(s); }
  close() { this.p.kill('SIGKILL'); }
}

const mode = (m: number, dir: boolean) => (dir ? 'd' : '-') + [6, 3, 0].map((s) => 'rwx'.split('').map((c, i) => ((m >> s >> (2 - i)) & 1 ? c : '-')).join('')).join('');

const sftp = {
  on() {},
  readdir: (p: string, cb: (e: Error | null, l?: { longname: string }[]) => void) => fs.readdir(p, { withFileTypes: true }, (e, l) => {
    if (e) return cb(e);
    cb(null, l.map((d) => { const s = fs.statSync(`${p}/${d.name}`, { throwIfNoEntry: false }); return { longname: `${mode(s?.mode ?? 0, d.isDirectory())} ${String(s?.size ?? 0).padStart(10)} ${d.name}` }; }));
  }),
  readFile: (p: string, cb: (e: Error | null, d?: Buffer) => void) => fs.readFile(p, cb),
  writeFile: (p: string, d: Buffer, o: { mode?: number }, cb: (e?: Error | null) => void) => fs.writeFile(p, d, o, cb),
};

export const localClient = () => ({
  on() { return this; },
  end() {},
  exec: (cmd: string, cb: (e: Error | undefined, ch: Chan) => void) => cb(undefined, new Chan(spawn(cmd, { shell: true }))),
  // ponytail: no pty (no prompt, no full-screen programs); node-pty if an agent needs those
  shell: (_o: unknown, cb: (e: Error | undefined, ch: Chan) => void) => cb(undefined, new Chan(spawn(process.platform === 'win32' ? 'cmd' : process.env.SHELL || 'sh', [], { stdio: 'pipe' }))),
  sftp: (cb: (e: Error | undefined, s: typeof sftp) => void) => cb(undefined, sftp),
});
