import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('development watcher ignores imported dependencies and runtime files but reloads source with current environment settings', { timeout: 20000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'mia-dev-watch-'));
  const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: { dev: string } };
  const args = manifest.scripts.dev.match(/"[^"]*"|\S+/g)!.map(value => value.replace(/^"|"$/g, ''));
  assert.equal(args.shift(), 'tsx'); assert.equal(args[0], 'watch');
  for (const folder of ['src', 'node_modules/probe', '.data', 'dist']) await mkdir(join(fixture, folder), { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
  await writeFile(join(fixture, '.env'), 'MIA_WATCH_PROBE=first\n');
  const dependency = join(fixture, 'node_modules/probe/index.js');
  await writeFile(dependency, 'export const value = 1;');
  const entry = join(fixture, 'src/main.ts');
  const source = (revision: number) => `import {value} from '../node_modules/probe/index.js'; console.log(JSON.stringify({pid:process.pid,value,revision:${revision},env:process.env.MIA_WATCH_PROBE})); setInterval(()=>{},1000);`;
  await writeFile(entry, source(1));
  const child = spawn(process.execPath, [cli, ...args], { cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      else { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]); }
    }
    const target = resolve(fixture);
    assert.equal(dirname(target), resolve(tmpdir())); assert.match(basename(target), /^mia-dev-watch-/);
    await rm(target, { recursive: true, force: true });
  });
  const reports: { pid: number; value: number; revision: number; env: string }[] = [];
  let buffer = '', errors = '';
  child.stdout.on('data', bytes => {
    buffer += bytes.toString(); const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) { try { const value = JSON.parse(line); if (value.pid) reports.push(value); } catch { /* Watcher status line. */ } }
  });
  child.stderr.on('data', bytes => { errors += bytes.toString(); });
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 5000;
    while (!predicate() && Date.now() < until && child.exitCode === null) await delay(25);
    assert.ok(predicate(), `Watcher did not reach the expected state: ${errors}; reports=${JSON.stringify(reports)}`);
  }
  await waitFor(() => reports.length === 1);
  assert.equal(reports[0]!.env, 'first');
  await writeFile(dependency, 'export const value = 2;');
  await writeFile(join(fixture, '.data/runtime.json'), '{}');
  await writeFile(join(fixture, 'dist/generated.js'), 'export {};');
  await delay(800);
  assert.equal(reports.length, 1, 'dependency/OneDrive or runtime-file churn must not interrupt sockets');
  await writeFile(entry, source(2));
  await waitFor(() => reports.some(report => report.revision === 2));
  assert.notEqual(reports.at(-1)!.pid, reports[0]!.pid); assert.equal(reports.at(-1)!.value, 2);
  await writeFile(join(fixture, '.env'), 'MIA_WATCH_PROBE=second\n');
  await writeFile(entry, source(3));
  await waitFor(() => reports.some(report => report.env === 'second'));
});
