import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { minimalEnv } from './argv-lane.js';
import { executeArgv, executeCommand } from './run-command.js';

const roots: string[] = [];
const pids = new Set<number>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(() => {
  // Also clean up the broken implementation's escaped fixtures when a regression fails.
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  pids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mercury-command-lifetime-'));
  roots.push(root);
  const script = join(root, 'worker.cjs');
  const output = join(root, 'writes.txt');
  const ready = join(root, 'ready.json');
  writeFileSync(script, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const [mode, output, ready] = process.argv.slice(2);
    if (mode === 'parent' || mode === 'redirected') {
      spawn(process.execPath, [__filename, 'writer', output, ready], { stdio: mode === 'redirected' ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
      const readyPulse = setInterval(() => {
        if (fs.existsSync(ready)) { console.log('child ready'); clearInterval(readyPulse); }
      }, 10);
    } else {
      process.on('SIGTERM', () => { console.log('ignoring TERM'); });
      fs.writeFileSync(ready + '.tmp', JSON.stringify({ pid: process.pid }));
      fs.renameSync(ready + '.tmp', ready);
      console.log('writer ready');
      setInterval(() => fs.appendFileSync(output, 'tick\\n'), 25);
      setTimeout(() => process.exit(0), 15000);
    }
  `);
  return { root, script, output, ready };
}

// Windows does not offer catchable POSIX SIGTERM. Native taskkill coverage
// below is separate from these POSIX escalation regressions.
describe.skipIf(process.platform === 'win32')('command termination lifetime', () => {
  it.each(['argv', 'shell descendant', 'redirected descendant'] as const)('waits for a TERM-ignoring %s to stop writing before settling', async (lane) => {
    const { root, script, output, ready } = fixture();
    const controller = new AbortController();
    let started = false;
    const onActivity = () => {
      if (started || !existsSync(ready)) return;
      started = true;
      pids.add(JSON.parse(readFileSync(ready, 'utf8')).pid);
      controller.abort();
    };
    const options = { signal: controller.signal, onActivity };
    // Abort only after the writer has installed its TERM handler and published
    // readiness. The timeout is a startup safety net, not a one-second race
    // against process creation on a loaded host. Fake-timer supervision tests
    // separately verify abort/timeout ordering during the SIGKILL grace period.
    const result = lane === 'argv'
      ? await executeArgv(process.execPath, [script, 'writer', output, ready], root, 10_000, options)
      : await executeCommand([process.execPath, script, lane === 'redirected descendant' ? 'redirected' : 'parent', output, ready].map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(' '), root, 10_000, options);
    expect(started).toBe(true);
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null });
    const before = existsSync(output) ? readFileSync(output, 'utf8') : '';
    await delay(150);
    const after = existsSync(output) ? readFileSync(output, 'utf8') : '';
    expect(after).toBe(before);
    if (lane !== 'redirected descendant') expect(result.stdout).toContain('ignoring TERM');
  }, 20_000);

});

describe('command output lifetime', () => {
  for (const runner of ['raw spawn', 'supervised', 'raw Windows kill-on-parent-exit control'] as const) {
    it.skipIf(runner === 'raw Windows kill-on-parent-exit control' && process.platform !== 'win32')(`descendant output after direct child exit: ${runner}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'mercury-command-drain-'));
      roots.push(root);
      const script = join(root, 'drain.cjs');
      const descendantPid = join(root, 'descendant.pid');
      const recordDescendant = () => {
        if (existsSync(descendantPid)) pids.add(Number(readFileSync(descendantPid, 'utf8')));
      };
      writeFileSync(script, `
        const { spawn } = require('node:child_process');
        if (process.argv[2] !== 'descendant') {
          const child = spawn(process.execPath, [__filename, 'descendant', String(process.pid)], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            // Node's bundled libuv assigns non-detached Windows children to a
            // kill-on-parent-exit Job. This fixture must survive to test draining.
            // https://github.com/nodejs/node/blob/v22.x/deps/uv/src/win/process.c
            detached: process.platform === 'win32' && ${runner !== 'raw Windows kill-on-parent-exit control'},
            windowsHide: true,
          });
          child.once('error', () => process.exit(1));
          // In particular on Windows, do not tear down the parent before the
          // descendant has initialized and flushed its inherited stdout handle.
          child.once('message', () => process.exit(0));
        } else {
          require('node:fs').writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid));
          const parentPid = Number(process.argv[3]);
          const deadline = Date.now() + 5000;
          const afterParentExit = () => {
            try { process.kill(parentPid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') {
                process.stdout.write('tail after parent exit\\n');
                return;
              }
              throw error;
            }
            if (Date.now() >= deadline) throw new Error('Parent did not exit');
            setTimeout(afterParentExit, 10);
          };
          process.once('disconnect', afterParentExit);
          process.stdout.write('descendant ready\\n', () => process.send('ready'));
        }
      `);
      const result = runner === 'supervised'
        ? await executeArgv(process.execPath, [script], root, 10_000, { onActivity: recordDescendant })
        : await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean }>((resolve, reject) => {
          // Raw Node control: no Mercury supervisor or cancellation hooks.
          const child = spawn(process.execPath, [script], {
            cwd: root, env: minimalEnv(), shell: false, windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          const timeout = setTimeout(() => { child.kill(); reject(new Error('Raw drain fixture timed out')); }, 10_000);
          child.stdout.on('data', (chunk) => { stdout += chunk.toString(); recordDescendant(); });
          child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
          child.once('error', (error) => { clearTimeout(timeout); reject(error); });
          child.once('close', (exitCode) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, exitCode, timedOut: false, aborted: false });
          });
        });
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, stderr: '' });
      expect(result.stdout).toContain('descendant ready');
      if (runner === 'raw Windows kill-on-parent-exit control') {
        // Negative control for libuv's own parent-owned Job: the descendant is
        // killed, so no tail exists for either Node or Mercury to drain.
        expect(result.stdout).not.toContain('tail after parent exit');
      } else {
        expect(result.stdout).toContain('tail after parent exit');
      }
    }, 15_000);
  }
});

describe.skipIf(process.platform !== 'win32')('native Windows command trees', () => {
  it.each(['argv', 'shell'] as const)('stops a %s tree before returning from cancellation', async (lane) => {
    const { root, script, output, ready } = fixture();
    const controller = new AbortController();
    let started = false;
    const onActivity = () => {
      if (started || !existsSync(ready)) return;
      started = true;
      pids.add(JSON.parse(readFileSync(ready, 'utf8')).pid);
      controller.abort();
    };
    const args = [script, 'redirected', output, ready];
    const options = { signal: controller.signal, onActivity };
    const result = lane === 'argv'
      ? await executeArgv(process.execPath, args, root, 10_000, options)
      : await executeCommand([process.execPath, ...args].map((arg) => `"${arg}"`).join(' '), root, 10_000, options);
    expect(started).toBe(true);
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null, stderr: '' });
    const before = existsSync(output) ? readFileSync(output, 'utf8') : '';
    await delay(150);
    expect(existsSync(output) ? readFileSync(output, 'utf8') : '').toBe(before);
  }, 15_000);
});
