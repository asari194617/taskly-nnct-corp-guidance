import type {
  Guidance,
  HomeTask,
  HomeTasksResponse,
  Preferences,
  User,
} from "./types";

export const OFFLINE_TTL = 24 * 60 * 60 * 1000;
const DATABASE = "taskly-guidance-offline";
const VERSION = 1;
const ACTIVE = "active";
const LOGOUT_INTENT = "logout-intent";
const MAX_MAP_BYTES = 20 * 1024 * 1024;

export type OfflineSession = {
  scope: string;
  generation: string;
  expiresAt: number;
};
export type OfflineHome = { data: HomeTasksResponse; savedAt: number };
export type OfflinePack = {
  session: OfflineSession;
  user: User;
  guidance: Guidance;
  preferences: Preferences;
  bookmarks: string[];
  savedAt: number;
  home?: OfflineHome;
};
type PackInput = Pick<
  OfflinePack,
  "user" | "guidance" | "preferences" | "bookmarks"
>;
type StoredPack = { schema: 1; dataset: string; pack: OfflinePack };
type StoredMap = {
  id: string;
  scope: string;
  dataset: string;
  savedAt: number;
  expiresAt: number;
  bytes: ArrayBuffer;
  mimeType: string;
};

// Operations retain call order. Invalidation also advances immediately, before
// an IndexedDB open or an older transaction can settle.
let epoch = 0;
let operations: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.catch(() => undefined);
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw Error();
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Error();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error();
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw Error();
  return value.map(parse);
}
function optional<T>(
  value: unknown,
  parse: (item: unknown) => T,
): T | undefined {
  return value === undefined ? undefined : parse(value);
}
function preferences(value: unknown): Preferences {
  const input = object(value);
  return {
    department: text(input.department),
    grade: number(input.grade),
    roster_number:
      input.roster_number === null ? null : number(input.roster_number),
  };
}
function guidance(value: unknown): Guidance {
  const input = object(value);
  const event = object(input.event);
  return {
    event: {
      title: text(event.title),
      date: text(event.date),
      venue: text(event.venue),
      description: text(event.description),
    },
    companies: list(input.companies, (value) => {
      const company = object(value);
      if (company.session !== "AM" && company.session !== "PM") throw Error();
      return {
        id: text(company.id),
        name: text(company.name),
        session: company.session,
        booth: number(company.booth),
        industries: list(company.industries, text),
        source_page: number(company.source_page),
      };
    }),
    schedule: list(input.schedule, (value) => {
      const slot = object(value);
      return {
        id: text(slot.id),
        session: text(slot.session),
        title: text(slot.title),
        start: text(slot.start),
        end: text(slot.end),
        term: optional(slot.term, number),
        required_grades: list(slot.required_grades, number),
      };
    }),
    assignments: list(input.assignments, (value) => {
      const assignment = object(value);
      return {
        department: text(assignment.department),
        grade: number(assignment.grade),
        number: number(assignment.number),
        visits: list(assignment.visits, (value) => {
          const visit = object(value);
          return {
            term: number(visit.term),
            company_id: text(visit.company_id),
          };
        }),
      };
    }),
    documents: list(input.documents, (value) => {
      const document = object(value);
      return {
        id: text(document.id),
        title: text(document.title),
        kind: text(document.kind),
        mime_type: text(document.mime_type),
        file_name: text(document.file_name),
        source_page: number(document.source_page),
        url: "",
        image_width: optional(document.image_width, number),
        image_height: optional(document.image_height, number),
        booths: optional(document.booths, (value) =>
          list(value, (value) => {
            const booth = object(value);
            return {
              booth: number(booth.booth),
              x: number(booth.x),
              y: number(booth.y),
              width: number(booth.width),
              height: number(booth.height),
            };
          }),
        ),
      };
    }),
    notices: list(input.notices, text),
    notice_sections: optional(input.notice_sections, (value) =>
      list(value, (value) => {
        const section = object(value);
        return {
          id: text(section.id),
          title: text(section.title),
          blocks: list(section.blocks, (value) => {
            const block = object(value);
            if (block.type === "paragraph")
              return { type: "paragraph" as const, text: text(block.text) };
            if (block.type === "list")
              return { type: "list" as const, items: list(block.items, text) };
            throw Error();
          }),
        };
      }),
    ),
  };
}
function home(value: unknown): HomeTasksResponse {
  const input = object(value);
  const sources = list(input.tasks, object);
  const tasks: HomeTask[] = sources.map((task) => {
    const kind = text(task.kind) as HomeTask["kind"];
    if (
      ![
        "assigned_visit",
        "visit_survey",
        "overall_survey",
        "sheet_submission",
      ].includes(kind)
    )
      throw Error();
    return {
      id: text(task.id),
      title: text(task.title),
      kind,
      completed: flag(task.completed),
      completion_disabled: flag(task.completion_disabled),
      taskly_url: "",
      company_id: optional(task.company_id, text),
      term: optional(task.term, number),
      document_id: optional(task.document_id, text),
      page: optional(task.page, number),
      due_at: optional(task.due_at, text),
    };
  });
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const hint = sources[index].auto_completed_by;
    if (
      task.kind !== "assigned_visit" ||
      !task.completed ||
      task.completion_disabled ||
      !Number.isInteger(task.term) ||
      task.term! <= 0 ||
      typeof hint !== "string" ||
      hint.length > 128 ||
      !/^[A-Za-z][A-Za-z0-9_-]*(?::[1-9]\d*)?$/.test(hint)
    )
      continue;
    const partners = tasks.filter(
      (candidate) =>
        candidate.kind === "visit_survey" && candidate.term === task.term,
    );
    // Keep only an already-present logical task relationship, never the bridge's
    // assignment scope or a transport response's unrelated metadata.
    if (
      partners.length === 1 &&
      partners[0].completed &&
      !partners[0].completion_disabled &&
      partners[0].id === hint &&
      hint !== task.id
    )
      task.auto_completed_by = hint;
  }
  return {
    event_id: text(input.event_id),
    roster_configured: flag(input.roster_configured),
    tasks,
  };
}

function scope(user: User, profile: Preferences, data: Guidance): string {
  return JSON.stringify([
    user.sub,
    profile.department,
    profile.grade,
    profile.roster_number,
    data.event.date,
  ]);
}
function parseStored(value: unknown, now: number): StoredPack | null {
  try {
    const record = object(value);
    if (record.schema !== 1) return null;
    const input = object(record.pack),
      identity = object(input.user);
    const user = {
      sub: text(identity.sub),
      name: text(identity.name),
      email: text(identity.email),
    };
    const profile = preferences(input.preferences),
      data = guidance(input.guidance);
    const savedAt = number(input.savedAt),
      session = object(input.session);
    const expiresAt = number(session.expiresAt),
      generation = text(session.generation);
    if (
      !generation ||
      savedAt > now + 60_000 ||
      expiresAt !== savedAt + OFFLINE_TTL ||
      expiresAt <= now ||
      text(session.scope) !== scope(user, profile, data)
    )
      return null;
    const pack: OfflinePack = {
      user,
      preferences: profile,
      guidance: data,
      savedAt,
      bookmarks: list(input.bookmarks, text),
      session: { scope: scope(user, profile, data), generation, expiresAt },
    };
    if (input.home !== undefined) {
      const snapshot = object(input.home),
        timestamp = number(snapshot.savedAt);
      if (timestamp <= now && timestamp + OFFLINE_TTL > now)
        pack.home = { data: home(snapshot.data), savedAt: timestamp };
    }
    const dataset = text(record.dataset);
    if (dataset !== JSON.stringify(data.documents)) return null;
    return { schema: 1, dataset, pack };
  } catch {
    return null;
  }
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(database);
    };
    const timer = setTimeout(() => finish(null), 2000);
    try {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("state"))
          database.createObjectStore("state");
        if (!database.objectStoreNames.contains("maps"))
          database.createObjectStore("maps", { keyPath: "id" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
      request.onerror = request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, result: (value: T) => void) => void,
): Promise<T | undefined> {
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise((resolve) => {
    let value: T | undefined;
    let finished = false;
    const finish = (result: T | undefined) => {
      if (finished) return;
      finished = true;
      database.close();
      resolve(result);
    };
    try {
      const tx = database.transaction(["state", "maps"], mode);
      tx.oncomplete = () => finish(value);
      tx.onabort = tx.onerror = () => finish(undefined);
      try {
        run(tx, (result) => {
          value = result;
        });
      } catch {
        tx.abort();
      }
    } catch {
      finish(undefined);
    }
  });
}
function purge(tx: IDBTransaction) {
  tx.objectStore("state").delete(ACTIVE);
  tx.objectStore("maps").clear();
}
function active(
  tx: IDBTransaction,
  callback: (record: StoredPack | null, blocked: boolean) => void,
) {
  const intent = tx.objectStore("state").get(LOGOUT_INTENT);
  intent.onsuccess = () => {
    if (intent.result === true) {
      purge(tx);
      callback(null, true);
      return;
    }
    const request = tx.objectStore("state").get(ACTIVE);
    request.onsuccess = () => {
      try {
        const record = parseStored(request.result, Date.now());
        if (request.result !== undefined && !record) purge(tx);
        callback(record, false);
      } catch {
        tx.abort();
      }
    };
  };
}

function matches(
  record: StoredPack | null,
  session: OfflineSession,
): record is StoredPack {
  return Boolean(
    record &&
    record.pack.session.scope === session.scope &&
    record.pack.session.generation === session.generation &&
    record.pack.session.expiresAt === session.expiresAt,
  );
}

export function restoreOfflinePack(
  expectedSub?: string,
): Promise<OfflinePack | null> {
  return enqueue(
    async () =>
      (await transaction<OfflinePack | null>("readwrite", (tx, result) => {
        active(tx, (record) => {
          if (
            record &&
            expectedSub !== undefined &&
            record.pack.user.sub !== expectedSub
          ) {
            epoch++;
            purge(tx);
            result(null);
          } else result(record?.pack ?? null);
        });
      })) ?? null,
  );
}
export function saveOfflinePack(
  input: PackInput,
  isCurrent = () => true,
): Promise<OfflinePack | null> {
  const captured = epoch;
  return enqueue(async () => {
    let normalized: PackInput;
    try {
      normalized = {
        user: {
          sub: text(input.user.sub),
          name: text(input.user.name),
          email: text(input.user.email),
        },
        guidance: guidance(input.guidance),
        preferences: preferences(input.preferences),
        bookmarks: list(input.bookmarks, text),
      };
    } catch {
      return null;
    }
    return (
      (await transaction<OfflinePack | null>("readwrite", (tx, result) => {
        active(tx, (previous, blocked) => {
          if (blocked || captured !== epoch || !isCurrent()) {
            result(null);
            return;
          }
          const savedAt = Date.now(),
            dataset = JSON.stringify(normalized.guidance.documents);
          const next: OfflinePack = {
            ...normalized,
            savedAt,
            session: {
              scope: scope(
                normalized.user,
                normalized.preferences,
                normalized.guidance,
              ),
              generation: crypto.randomUUID(),
              expiresAt: savedAt + OFFLINE_TTL,
            },
          };
          if (
            previous?.pack.session.scope === next.session.scope &&
            previous.dataset === dataset
          ) {
            if (previous.pack.home) next.home = previous.pack.home;
          } else tx.objectStore("maps").clear();
          tx.objectStore("state").put(
            { schema: 1, dataset, pack: next } satisfies StoredPack,
            ACTIVE,
          );
          result(next);
        });
      })) ?? null
    );
  });
}
export function clearOfflinePack(): Promise<void> {
  epoch++;
  return enqueue(async () => {
    await transaction("readwrite", (tx) => purge(tx));
  });
}
export function readOfflineLogoutIntent(): Promise<boolean> {
  return enqueue(
    async () =>
      (await transaction<boolean>("readonly", (tx, result) => {
        const request = tx.objectStore("state").get(LOGOUT_INTENT);
        request.onsuccess = () => result(request.result === true);
      })) ?? false,
  );
}
export function setOfflineLogoutIntent(blocked: boolean): Promise<void> {
  if (blocked) epoch++;
  return enqueue(async () => {
    await transaction("readwrite", (tx) => {
      if (blocked) {
        tx.objectStore("state").put(true, LOGOUT_INTENT);
        purge(tx);
      } else tx.objectStore("state").delete(LOGOUT_INTENT);
    });
  });
}
export function deleteOfflineHome(session: OfflineSession): Promise<void> {
  return updatePack(session, (record, tx) => {
    delete record.pack.home;
    tx.objectStore("state").put(record, ACTIVE);
  });
}
export function readOfflineHome(
  session: OfflineSession,
): Promise<OfflineHome | null> {
  return enqueue(
    async () =>
      (await transaction<OfflineHome | null>("readwrite", (tx, result) => {
        active(tx, (record) =>
          result(matches(record, session) ? (record.pack.home ?? null) : null),
        );
      })) ?? null,
  );
}
function updatePack(
  session: OfflineSession,
  update: (record: StoredPack, tx: IDBTransaction) => void,
): Promise<void> {
  const captured = epoch;
  return enqueue(async () => {
    await transaction("readwrite", (tx) => {
      active(tx, (record) => {
        if (captured !== epoch || !matches(record, session)) return;
        update(record, tx);
      });
    });
  });
}
export function saveOfflineHome(
  session: OfflineSession,
  data: HomeTasksResponse,
): Promise<void> {
  let snapshot: HomeTasksResponse;
  try {
    snapshot = home(data);
  } catch {
    return Promise.resolve();
  }
  return updatePack(session, (record, tx) => {
    record.pack.home = { data: snapshot, savedAt: Date.now() };
    tx.objectStore("state").put(record, ACTIVE);
  });
}
export function updateOfflineBookmarks(
  session: OfflineSession,
  ids: string[],
): Promise<void> {
  let bookmarks: string[];
  try {
    bookmarks = list(ids, text);
  } catch {
    return Promise.resolve();
  }
  return updatePack(session, (record, tx) => {
    record.pack.bookmarks = bookmarks;
    tx.objectStore("state").put(record, ACTIVE);
  });
}
export function readOfflineMap(
  session: OfflineSession,
  id: string,
): Promise<Blob | null> {
  return enqueue(
    async () =>
      (await transaction<Blob | null>("readwrite", (tx, result) => {
        active(tx, (record) => {
          if (!matches(record, session)) {
            result(null);
            return;
          }
          const request = tx.objectStore("maps").get(id);
          request.onsuccess = () => {
            const map = request.result as StoredMap | undefined;
            if (
              map &&
              map.scope === record.pack.session.scope &&
              map.dataset === record.dataset &&
              typeof map.savedAt === "number" &&
              Number.isFinite(map.savedAt) &&
              map.savedAt <= Date.now() &&
              typeof map.expiresAt === "number" &&
              Number.isFinite(map.expiresAt) &&
              map.expiresAt > Date.now() &&
              map.expiresAt <= map.savedAt + OFFLINE_TTL &&
              map.expiresAt <= record.pack.session.expiresAt &&
              validMapBytes(map.bytes) &&
              typeof map.mimeType === "string" &&
              map.mimeType.startsWith("image/")
            )
              result(new Blob([map.bytes], { type: map.mimeType }));
            else {
              if (map) tx.objectStore("maps").delete(id);
              result(null);
            }
          };
        });
      })) ?? null,
  );
}
function validMapBytes(value: unknown): value is ArrayBuffer {
  try {
    // IndexedDB and Blob implementations may return a buffer from another
    // realm. Its native byteLength getter validates the internal buffer slot
    // without relying on a realm-specific instanceof check.
    const size = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )?.get?.call(value);
    return typeof size === "number" && size > 0 && size <= MAX_MAP_BYTES;
  } catch {
    return false;
  }
}
export async function saveOfflineMap(
  session: OfflineSession,
  id: string,
  blob: Blob,
): Promise<void> {
  const captured = epoch;
  if (
    !(blob instanceof Blob) ||
    !blob.type.startsWith("image/") ||
    blob.size === 0 ||
    blob.size > MAX_MAP_BYTES
  )
    return;
  let bytes: ArrayBuffer;
  try {
    // WebKit can reject a native Blob with UnknownError during IDB cloning.
    // Finish byte extraction before creating the transaction: no asynchronous
    // work may outlive the transaction or cross a logout invalidation.
    bytes = await blob.arrayBuffer();
  } catch {
    return;
  }
  if (
    captured !== epoch ||
    !validMapBytes(bytes) ||
    bytes.byteLength !== blob.size
  )
    return;
  return updatePack(session, (record, tx) => {
    if (
      !record.pack.guidance.documents.some(
        (document) =>
          document.id === id &&
          document.kind === "map" &&
          document.mime_type.startsWith("image/"),
      )
    )
      return;
    const savedAt = Date.now();
    tx.objectStore("maps").put({
      id,
      scope: session.scope,
      dataset: record.dataset,
      bytes,
      mimeType: blob.type,
      savedAt,
      expiresAt: session.expiresAt,
    } satisfies StoredMap);
  });
}
