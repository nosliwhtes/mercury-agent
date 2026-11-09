# Foreground command lifecycle

`run_command` owns a foreground command until its child process and output
streams close. The direct child's `exit` event is not enough: descendants can
still hold stdout or stderr open and write a final result after that event.
The command timeout remains active while those streams drain.

Cancellation and timeout share one shutdown path. The first reason wins, so an
abort followed by a timeout during shutdown is still reported as an abort. An
already-aborted call starts no process. Output received during shutdown remains
available in the result.

## POSIX

Both execution lanes create a dedicated process group. Shell-free execution
still uses the pinned binary, literal arguments and minimal environment. On
cancellation, Mercury sends SIGTERM to the group, then SIGKILL after five
seconds if its output has not closed. If the leader and output close first,
Mercury sends SIGKILL to remaining group members immediately, including ones
that redirected their output, before releasing the command.

Detached groups do not receive terminal foreground-group signals. A single
process-exit hook therefore sends SIGKILL to groups that Mercury still owns.
It covers Mercury's existing orderly shutdown and uncaught-exception handlers
when they call `process.exit`. The hook is removed when no command is active.
This does not change Mercury's SIGINT/SIGTERM shutdown or SIGHUP daemonization
handlers. Their existing asynchronous shutdown work can still delay exit.

This is best-effort cleanup, not containment. SIGKILL of Mercury, native crashes,
or a descendant deliberately creating a separate session can bypass it. A
successful group signal is not proof that every redirected descendant has
already been reaped. An escaped descendant retaining a pipe can delay stream
closure indefinitely; this is not a bounded-cancellation guarantee. Normally
completed commands are not treated as cancelled.

## Windows

Cancellation runs the system `taskkill.exe /pid <pid> /T /F` before releasing the
command, and waits for both taskkill's callback and the child's stream closure.
A taskkill failure is reported in the tool result and falls back to killing the
direct child. Descendants may survive that failure, or the leader exiting before
taskkill can discover the tree. This does not provide Windows Job-object or
parent-crash containment.

## Regression coverage

- Real POSIX processes that ignore SIGTERM, including shell descendants and
  descendants with redirected output.
- Output written by an inherited-stream descendant after its parent exits.
- First-reason cancellation, grace escalation, spawn errors, stream closure,
  concurrent exit-hook ownership and both Windows callback/close orderings.
- Native Windows argv and shell tree tests, gated to Windows. Mocked taskkill
  tests on another platform do not establish native Windows behavior.

Run the focused suite with `npx vitest run src/capabilities/shell`.
