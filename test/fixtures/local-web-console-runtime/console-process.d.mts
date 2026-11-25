/** True when the pid is a live, non-zombie process: signal 0 plus Linux /proc state. */
export declare function pidAlive(pid: number | undefined): boolean;

/** Resolves once the pid is gone (or was never alive), bounded by timeoutMs. */
export declare function waitForExit(pid: number | undefined, timeoutMs?: number): Promise<void>;

/** PIDs of console-server.mjs processes whose cmdline carries this state dir (Linux /proc scan). */
export declare function leakedConsoleServerPids(stateDir: string): number[];

/**
 * Test cleanup that holds even on failure: stop the recorded instance, wait for the pid to
 * exit, kill any leaked server still carrying this state dir, and throw
 * "leaked console-server pid …" so the test fails loudly instead of leaving orphans.
 */
export declare function reapConsoleServer(stop: () => { status: number | null }, state: string): Promise<void>;
