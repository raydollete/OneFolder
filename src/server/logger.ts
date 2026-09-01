/**
 * Serve-mode logger — writes to a file AND to stdout.
 *
 * Why a file log is mandatory rather than a convenience:
 * the portable executable is a Windows GUI-subsystem binary, so its standard
 * output does not reliably attach to the console that launched it.  Measured
 * behaviour: output vanished entirely on some runs, then arrived late and
 * interleaved with a later command's output.  Serve mode therefore treats the
 * file as the record and stdout as a bonus.
 *
 * Writes are synchronous (appendFileSync) on purpose: the operator-facing
 * failures are followed immediately by process exit, and a buffered stream
 * would lose exactly the lines that matter most.  Volume is low (a startup
 * banner, errors, shutdown), so the cost is irrelevant.
 */

import path from 'path';
import fse from 'fs-extra';

export interface ServerLogger {
  /** Log an informational line verbatim. */
  info(message: string): void;
  /** Log a warning line verbatim. */
  warn(message: string): void;
  /** Log an error line verbatim. */
  error(message: string): void;
  /** Absolute path of the file being written, for the startup banner. */
  readonly filePath: string;
}

function formatUnwritableWarning(filePath: string, err: unknown): string {
  return `[server] WARNING: could not write to log file ${filePath}: ${String(err)}`;
}

/**
 * Create a logger that appends to `logFilePath` and mirrors to stdout/stderr.
 *
 * If the file cannot be opened or written, logging degrades to console-only
 * rather than taking the server down — but it says so, once.
 */
export function createServerLogger(logFilePath: string): ServerLogger {
  let fileWritable = true;

  try {
    fse.mkdirsSync(path.dirname(logFilePath));
    // Session separator so restarts are distinguishable in a long-lived file.
    fse.appendFileSync(
      logFilePath,
      `\n=== OneFolder server started ${new Date().toISOString()} ===\n`,
    );
  } catch (err) {
    fileWritable = false;
    console.warn(formatUnwritableWarning(logFilePath, err));
  }

  function write(message: string): void {
    if (!fileWritable) {
      return;
    }
    try {
      fse.appendFileSync(logFilePath, message + '\n');
    } catch (err) {
      fileWritable = false;
      console.warn(formatUnwritableWarning(logFilePath, err));
    }
  }

  return {
    filePath: logFilePath,
    info(message: string): void {
      console.info(message);
      write(message);
    },
    warn(message: string): void {
      console.warn(message);
      write(message);
    },
    error(message: string): void {
      console.error(message);
      write(message);
    },
  };
}

/**
 * A logger that only writes to the console — used before a log-file path is
 * known, and by tests.
 */
export function createConsoleLogger(): ServerLogger {
  return {
    filePath: '',
    info: (m) => console.info(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}
