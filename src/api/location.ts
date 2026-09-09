import { ID } from './id';

export type LocationDTO = {
  id: ID;
  path: string;
  dateAdded: Date;
  subLocations: SubLocationDTO[];
  index: number;
  /**
   * Portable anchor (optional). When PRESENT, this location's root is stored
   * relative to the portable application directory: the effective absolute root
   * is resolved per-OS at load as `join(portableRoot, segment)`, and `path`
   * above becomes a derived per-OS value rather than the durable root. When
   * ABSENT (undefined), the location is unanchored — `path` is a fixed absolute
   * path (e.g. an external drive outside the portable directory), unchanged
   * across OSes. The segment preserves the real on-disk case of each component
   * so it resolves on a case-sensitive filesystem; an empty string means the
   * location is anchored at the portable root itself.
   */
  portableRoot?: string;
};

export type SubLocationDTO = {
  name: string;
  isExcluded: boolean;
  subLocations: SubLocationDTO[];
};
