import * as crypto from 'crypto';
import fse from 'fs-extra';
import * as os from 'os';
import path from 'path';

import { LibraryRegistry } from '../common/library-registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `onefolder-test-${crypto.randomUUID()}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LibraryRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fse.ensureDirSync(tmpDir);
  });

  afterEach(() => {
    fse.removeSync(tmpDir);
  });

  // 1. Constructor returns empty list on a fresh base directory
  it('returns empty list and null active ID on fresh base directory', () => {
    const registry = new LibraryRegistry(tmpDir);
    expect(registry.getLibraries()).toEqual([]);
    expect(registry.getActiveLibraryId()).toBeNull();
  });

  // 2. createLibrary round-trip
  it('createLibrary returns a valid LibraryDTO', () => {
    const registry = new LibraryRegistry(tmpDir);
    const before = new Date();
    const lib = registry.createLibrary('Test Library');
    const after = new Date();

    expect(lib.name).toBe('Test Library');
    expect(typeof lib.id).toBe('string');
    // UUID: 36 chars with hyphens (8-4-4-4-12 pattern)
    expect(lib.id).toHaveLength(36);
    expect(lib.id.split('-')).toHaveLength(5);
    expect(lib.createdAt).toBeInstanceOf(Date);
    expect(lib.lastOpenedAt).toBeInstanceOf(Date);
    expect(lib.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lib.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(lib.lastOpenedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lib.lastOpenedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  // 3. createLibrary persists across instances — and Date objects survive (de)serialization
  it('createLibrary persists across registry instances with Date objects (not strings)', () => {
    const registryA = new LibraryRegistry(tmpDir);
    registryA.createLibrary('Persistent Library');

    const registryB = new LibraryRegistry(tmpDir);
    const libs = registryB.getLibraries();
    expect(libs).toHaveLength(1);
    expect(libs[0].name).toBe('Persistent Library');
    expect(libs[0].createdAt).toBeInstanceOf(Date);
    expect(libs[0].lastOpenedAt).toBeInstanceOf(Date);
  });

  // 4. setActiveLibrary + getActiveLibraryId round-trip, across instances
  it('setActiveLibrary + getActiveLibraryId round-trip across instances', () => {
    const registryA = new LibraryRegistry(tmpDir);
    const lib = registryA.createLibrary('Active Library');
    registryA.setActiveLibrary(lib.id);
    expect(registryA.getActiveLibraryId()).toBe(lib.id);

    const registryB = new LibraryRegistry(tmpDir);
    expect(registryB.getActiveLibraryId()).toBe(lib.id);
  });

  // 5. getActiveLibraryId returns null when the file is missing
  it('getActiveLibraryId returns null when active-library.json is missing', () => {
    const registry = new LibraryRegistry(tmpDir);
    const activeLibraryPath = path.join(tmpDir, 'active-library.json');
    // Ensure it does not exist
    fse.removeSync(activeLibraryPath);
    expect(registry.getActiveLibraryId()).toBeNull();
  });

  // 6. getActiveLibraryId returns null when the file is malformed
  it('getActiveLibraryId returns null when active-library.json contains garbage', () => {
    const registry = new LibraryRegistry(tmpDir);
    const activeLibraryPath = path.join(tmpDir, 'active-library.json');
    fse.writeFileSync(activeLibraryPath, 'not json');
    expect(registry.getActiveLibraryId()).toBeNull();
  });

  // 7. renameLibrary updates the name and persists
  it('renameLibrary updates the name and persists across instances', () => {
    const registryA = new LibraryRegistry(tmpDir);
    const lib = registryA.createLibrary('Old Name');
    registryA.renameLibrary(lib.id, 'New Name');
    expect(registryA.getLibraries()[0].name).toBe('New Name');

    const registryB = new LibraryRegistry(tmpDir);
    expect(registryB.getLibraries()[0].name).toBe('New Name');
  });

  // 8. renameLibrary with unknown ID is a no-op
  it('renameLibrary with an unknown ID is a no-op and does not throw', () => {
    const registry = new LibraryRegistry(tmpDir);
    expect(() => registry.renameLibrary('non-existent-id', 'Ghost Library')).not.toThrow();
    expect(registry.getLibraries()).toHaveLength(0);
  });

  // 9. deleteLibrary removes the entry and persists
  it('deleteLibrary removes the correct entry and persists', () => {
    const registryA = new LibraryRegistry(tmpDir);
    const libA = registryA.createLibrary('Library A');
    const libB = registryA.createLibrary('Library B');
    registryA.deleteLibrary(libA.id);

    const remaining = registryA.getLibraries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(libB.id);

    const registryB = new LibraryRegistry(tmpDir);
    const persistedRemaining = registryB.getLibraries();
    expect(persistedRemaining).toHaveLength(1);
    expect(persistedRemaining[0].id).toBe(libB.id);
  });

  // 10. deleteLibrary does NOT touch active-library.json
  it('deleteLibrary does NOT modify active-library.json (caller responsibility)', () => {
    const registry = new LibraryRegistry(tmpDir);
    const lib = registry.createLibrary('Active Library');
    registry.setActiveLibrary(lib.id);
    registry.deleteLibrary(lib.id);

    // The active-library.json should still contain the deleted library's ID
    expect(registry.getActiveLibraryId()).toBe(lib.id);
  });

  // 11. updateLastOpened mutates lastOpenedAt and persists
  it('updateLastOpened mutates lastOpenedAt to a later timestamp and persists', async () => {
    const registryA = new LibraryRegistry(tmpDir);
    const lib = registryA.createLibrary('Opened Library');
    const originalTimestamp = registryA.getLibraries()[0].lastOpenedAt.getTime();

    // Wait a small amount to guarantee a strictly later timestamp
    await new Promise((resolve) => setTimeout(resolve, 15));
    registryA.updateLastOpened(lib.id);

    const updatedTimestamp = registryA.getLibraries()[0].lastOpenedAt.getTime();
    expect(updatedTimestamp).toBeGreaterThan(originalTimestamp);

    // Confirm persistence
    const registryB = new LibraryRegistry(tmpDir);
    expect(registryB.getLibraries()[0].lastOpenedAt.getTime()).toBe(updatedTimestamp);
  });

  // 12. updateLastOpened with unknown ID is a no-op
  it('updateLastOpened with an unknown ID is a no-op and does not throw', () => {
    const registry = new LibraryRegistry(tmpDir);
    expect(() => registry.updateLastOpened('non-existent-id')).not.toThrow();
  });

  // 13. createLibrary allows duplicate names
  it('createLibrary allows duplicate names with distinct IDs', () => {
    const registry = new LibraryRegistry(tmpDir);
    const libA = registry.createLibrary('My Library');
    const libB = registry.createLibrary('My Library');

    const libs = registry.getLibraries();
    expect(libs).toHaveLength(2);
    expect(libA.id).not.toBe(libB.id);
    expect(libs[0].name).toBe('My Library');
    expect(libs[1].name).toBe('My Library');
  });

  // 14. libraries.json is written with 2-space indentation
  it('libraries.json is written with 2-space indentation', () => {
    const registry = new LibraryRegistry(tmpDir);
    registry.createLibrary('Formatted Library');

    const librariesPath = path.join(tmpDir, 'libraries.json');
    const raw = fse.readFileSync(librariesPath, 'utf-8');
    // 2-space indent means there is a newline followed by two spaces somewhere
    expect(raw).toContain('\n  ');
  });
});
