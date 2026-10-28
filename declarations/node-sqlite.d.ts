/**
 * Minimal ambient types for `node:sqlite` (change: support-mov-playback).
 *
 * The repo pins TypeScript 4.9 whose bundled @types/node predates the
 * node:sqlite built-in. Only the surface used by
 * tests/sqlite-codec-migration.test.ts is declared (better-sqlite3's native
 * binary is Electron-ABI and cannot load under jest, so the codec-migration
 * test runs the same SQL through node:sqlite).
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): void;
  }

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
