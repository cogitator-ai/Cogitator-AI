/**
 * Memory items and entities as JSON keeps them, and back: a storage that writes them as JSON
 * reads its dates back as dates with these
 */

import type {
  MemoryEntity,
  MemoryFileVersion,
  MemoryItem,
  MemoryItemTime,
} from '@cogitator-ai/types';

/** A memory item time as JSON holds it, its dates as ISO text */
export type StoredMemoryItemTime = Omit<MemoryItemTime, 'start' | 'end'> & {
  start?: string;
  end?: string;
};

/** A memory item as JSON holds it, its dates as ISO text */
export type StoredMemoryItem = Omit<
  MemoryItem,
  | 'saidAt'
  | 'sessionAt'
  | 'about'
  | 'validFrom'
  | 'validTo'
  | 'recordedAt'
  | 'expiredAt'
  | 'lastRetrievedAt'
> & {
  lastRetrievedAt?: string;
  saidAt: string;
  sessionAt: string;
  about?: StoredMemoryItemTime;
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
  expiredAt?: string;
};

/** A memory entity as JSON holds it, its dates as ISO text */
export type StoredMemoryEntity = Omit<MemoryEntity, 'firstSeenAt' | 'lastSeenAt'> & {
  firstSeenAt: string;
  lastSeenAt: string;
};

function timeFrom({ start, end, ...time }: StoredMemoryItemTime): MemoryItemTime {
  return {
    ...time,
    ...(start !== undefined && { start: new Date(start) }),
    ...(end !== undefined && { end: new Date(end) }),
  };
}

/** The memory item `stored` holds, its dates as dates and absent fields left absent */
export function memoryItemFromJson(stored: StoredMemoryItem): MemoryItem {
  const {
    saidAt,
    sessionAt,
    about,
    validFrom,
    validTo,
    recordedAt,
    expiredAt,
    lastRetrievedAt,
    ...item
  } = stored;
  return {
    ...item,
    ...(lastRetrievedAt !== undefined && { lastRetrievedAt: new Date(lastRetrievedAt) }),
    saidAt: new Date(saidAt),
    sessionAt: new Date(sessionAt),
    ...(about !== undefined && { about: timeFrom(about) }),
    ...(validFrom !== undefined && { validFrom: new Date(validFrom) }),
    ...(validTo !== undefined && { validTo: new Date(validTo) }),
    recordedAt: new Date(recordedAt),
    ...(expiredAt !== undefined && { expiredAt: new Date(expiredAt) }),
  };
}

/** The memory entity `stored` holds, its dates as dates */
export function memoryEntityFromJson(stored: StoredMemoryEntity): MemoryEntity {
  const { firstSeenAt, lastSeenAt, ...entity } = stored;
  return { ...entity, firstSeenAt: new Date(firstSeenAt), lastSeenAt: new Date(lastSeenAt) };
}

/** A memory file version as JSON holds it, its dates as ISO text */
export type StoredMemoryFileVersion = Omit<MemoryFileVersion, 'createdAt' | 'redacted'> & {
  createdAt: string;
  redacted?: { at: string; reason?: string };
};

/** The memory file version `stored` holds, its dates as dates and absent fields left absent */
export function memoryFileVersionFromJson(stored: StoredMemoryFileVersion): MemoryFileVersion {
  const { createdAt, redacted, ...version } = stored;
  return {
    ...version,
    createdAt: new Date(createdAt),
    ...(redacted && {
      redacted: {
        at: new Date(redacted.at),
        ...(redacted.reason !== undefined && { reason: redacted.reason }),
      },
    }),
  };
}
