/**
 * Enough of the extension APIs to exercise the vault in Node.
 *
 * Not a mock of Chrome — a stand-in for the three things the vault actually
 * touches, with the ONE property that matters kept honest: `storage.session`
 * and `storage.local` are separate stores, because the entire security claim
 * of this vault is that the unwrapped key lives in the first and never the
 * second. A fake that backed both with one object would agree with the bug it
 * exists to catch.
 */
type Store = Record<string, unknown>;

function area(backing: Store) {
  return {
    async get(key: string): Promise<Store> {
      return key in backing ? { [key]: backing[key] } : {};
    },
    async set(items: Store): Promise<void> {
      Object.assign(backing, items);
    },
    async remove(key: string): Promise<void> {
      delete backing[key];
    },
    async setAccessLevel(_: { accessLevel: string }): Promise<void> {},
    /** Test-only window onto what was actually written. */
    _raw: backing,
  };
}

export interface FakeChrome {
  storage: { local: ReturnType<typeof area>; session: ReturnType<typeof area> };
  alarms: {
    create(name: string, info: { delayInMinutes: number }): Promise<void>;
    clear(name: string): Promise<void>;
    _created: { name: string; delayInMinutes: number }[];
  };
}

export function install(): FakeChrome {
  const created: { name: string; delayInMinutes: number }[] = [];
  const fake: FakeChrome = {
    storage: { local: area({}), session: area({}) },
    alarms: {
      async create(name, info) {
        created.push({ name, ...info });
      },
      async clear(name) {
        for (let i = created.length - 1; i >= 0; i--) if (created[i]!.name === name) created.splice(i, 1);
      },
      _created: created,
    },
  };
  (globalThis as { chrome?: unknown }).chrome = fake;
  return fake;
}
