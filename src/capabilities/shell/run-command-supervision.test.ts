import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createRunCommandTool, executeArgv } from './run-command.js';
import type { PermissionManager } from '../permissions.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));

let child: ChildProcess;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'linux' });
  child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function start(timeout = 1000) {
  const controller = new AbortController();
  const settled = vi.fn();
  const result = executeArgv('/pinned/program', ['literal argument'], '/work', timeout, { signal: controller.signal });
  void result.then(settled);
  return { controller, result, settled };
}

describe('command supervision', () => {
  it('owns detached POSIX groups through Mercury exit and unregisters after close', async () => {
    const previous = process.listeners('exit');
    const { result } = start();
    const hooks = process.listeners('exit').filter((listener) => !previous.includes(listener));
    expect(hooks).toHaveLength(1);
    hooks[0](1); // The synchronous hook also runs on Mercury's crash-handler exit.
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null);
    await result;
    expect(process.listeners('exit')).toEqual(previous);
  });

  it('shares one exit hook across concurrent POSIX commands', async () => {
    const previous = process.listeners('exit');
    const firstChild = child;
    const first = start();
    child = Object.assign(new EventEmitter(), {
      pid: 23456, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    const second = start();
    const hooks = process.listeners('exit').filter((listener) => !previous.includes(listener));
    expect(hooks).toHaveLength(1);
    firstChild.emit('close', 0);
    await first.result;
    hooks[0](1);
    expect(process.kill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(process.kill).toHaveBeenCalledWith(-23456, 'SIGKILL');
    child.emit('close', 0);
    await second.result;
    expect(process.listeners('exit')).toEqual(previous);
  });

  it('does not spawn work for an already-aborted turn', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await executeArgv('/pinned/program', [], '/work', 1000, { signal: controller.signal }))
      .toMatchObject({ aborted: true, timedOut: false, exitCode: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves synchronous spawn errors', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('spawn failed'); });
    expect(await executeArgv('/pinned/program', [], '/work', 1000))
      .toMatchObject({ stderr: 'Process error: spawn failed', aborted: false, timedOut: false, exitCode: null });
  });

  it('waits for close and captures output delivered after exit', async () => {
    const { result, settled } = start();
    child.emit('exit', 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from('last stdout'));
    child.stderr!.emit('data', Buffer.from('last stderr'));
    child.emit('close', 0);
    expect(await result).toMatchObject({ stdout: 'last stdout', stderr: 'last stderr', exitCode: 0, aborted: false, timedOut: false });
  });

  it('keeps SIGKILL escalation armed after abort and waits for actual close', async () => {
    const { controller, result, settled } = start();
    controller.abort();
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1000); // The command's later timeout cannot replace the abort.
    child.emit('exit', null, 'SIGTERM');
    child.stdout!.emit('data', Buffer.from('shutdown output'));
    expect(settled).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(4000);
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', null);
    expect(await result).toMatchObject({ stdout: 'shutdown output', exitCode: null, aborted: true, timedOut: false });
  });

  it('keeps the timeout result if an abort arrives during shutdown', async () => {
    const { controller, result } = start(100);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    child.emit('close', null);
    expect(await result).toMatchObject({ exitCode: null, aborted: false, timedOut: true });
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('preserves spawn errors and waits for close', async () => {
    const { result, settled } = start();
    child.emit('error', new Error('spawn EACCES'));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', -13);
    expect(await result).toMatchObject({ stderr: '\nProcess error: spawn EACCES', exitCode: null, aborted: false, timedOut: false });
  });

  it('waits for the Windows tree termination command as well as close', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const previous = process.listeners('exit');
    const { controller, result, settled } = start();
    expect(process.listeners('exit')).toEqual(previous);
    controller.abort();
    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/taskkill\.exe$/), ['/pid', '12345', '/T', '/F'],
      { windowsHide: true, timeout: 5000 }, expect.any(Function),
    );
    child.emit('close', null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const callback = vi.mocked(execFile).mock.calls[0][3] as unknown as (error: Error | null) => void;
    callback(null);
    expect(await result).toMatchObject({ exitCode: null, aborted: true, timedOut: false });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('still waits for Windows close if taskkill completes first', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { controller, result, settled } = start();
    controller.abort();
    const callback = vi.mocked(execFile).mock.calls[0][3] as unknown as (error: Error | null) => void;
    callback(null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from('last output'));
    child.emit('close', null);
    expect(await result).toMatchObject({ stdout: 'last output', aborted: true });
  });

  it('reports a Windows tree cleanup error and still waits for the child to close', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { controller, result, settled } = start();
    controller.abort();
    const callback = vi.mocked(execFile).mock.calls[0][3] as unknown as (error: Error | null) => void;
    callback(new Error('taskkill unavailable'));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', null);
    expect(await result).toMatchObject({
      stderr: '\nProcess tree termination error: taskkill unavailable', aborted: true,
      terminationError: 'Process tree termination error: taskkill unavailable',
    });
  });

  it.each(['abort', 'timeout'] as const)('surfaces tree cleanup failures in the %s tool response', async (reason) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const permissions = { checkShellCommand: vi.fn(async () => ({ allowed: true, lane: 'shell' })) } as unknown as PermissionManager;
    const tool = createRunCommandTool(permissions, () => '/work', () => {});
    const controller = new AbortController();
    const result = tool.execute!({ command: 'echo ready | cat', timeout: 0.1 }, {
      toolCallId: 'test', messages: [], abortSignal: controller.signal,
    });
    await Promise.resolve(); // The permission check resolves before process startup.
    if (reason === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    const callback = vi.mocked(execFile).mock.calls[0][3] as unknown as (error: Error | null) => void;
    callback(new Error('taskkill unavailable'));
    child.emit('close', null);
    expect(await result).toContain('descendants may still be running');
    expect(await result).toContain('taskkill unavailable');
  });

  it('handles abort during a Windows spawn failure without waiting for a nonexistent PID', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(child, 'pid', { value: undefined });
    const { controller, result } = start();
    controller.abort();
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null);
    expect(await result).toMatchObject({ stderr: '\nProcess error: spawn ENOENT', aborted: true });
    expect(execFile).not.toHaveBeenCalled();
  });
});
