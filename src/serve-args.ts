/**
 * Serve-mode argument parsing.
 *
 * Dependency-free on purpose: `src/main.ts` calls this at module scope, before
 * the single-instance lock and before anything heavier than Electron itself is
 * loaded, and tests exercise it without pulling in the server.
 */

export interface ServeArgs {
  /** True when `--serve` was passed. */
  serve: boolean;
  /** Raw `--port` value, or undefined when not passed. */
  rawPort: string | undefined;
}

/**
 * Parse serve-mode flags out of an argv array.
 *
 * The flag is `--serve`, deliberately NOT `--headless`: that collides with
 * Chromium's own `--headless` switch on an Electron binary, and reads as "no UI
 * at all" rather than "serve instead of show".
 *
 * Accepts `--port 9000` and `--port=9000`.
 */
export function parseServeArgs(argv: readonly string[]): ServeArgs {
  let serve = false;
  let rawPort: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--serve') {
      serve = true;
    } else if (arg === '--port') {
      rawPort = argv[i + 1];
      i++;
    } else if (arg.startsWith('--port=')) {
      rawPort = arg.slice('--port='.length);
    }
  }

  return { serve, rawPort };
}
