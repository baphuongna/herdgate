export interface ConsoleStorage {
  readonly length: number;
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface ConsoleStorageHost {
  localStorage: ConsoleStorage;
  sessionStorage: ConsoleStorage;
}

type StorageProperty = "localStorage" | "sessionStorage";

function memoryStorage(): ConsoleStorage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(String(key)) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
}

function restoreProperty(host: ConsoleStorageHost, property: StorageProperty, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(host, property, descriptor);
  else Reflect.deleteProperty(host, property);
}

/** Replace browser-persistent storage with per-tab memory before mounting Ovis components. */
export function installConsoleStorageGuard(host: ConsoleStorageHost): () => void {
  const descriptors = new Map<StorageProperty, PropertyDescriptor | undefined>([
    ["localStorage", Object.getOwnPropertyDescriptor(host, "localStorage")],
    ["sessionStorage", Object.getOwnPropertyDescriptor(host, "sessionStorage")],
  ]);
  try {
    Object.defineProperty(host, "localStorage", { configurable: true, enumerable: descriptors.get("localStorage")?.enumerable ?? true, value: memoryStorage() });
    Object.defineProperty(host, "sessionStorage", { configurable: true, enumerable: descriptors.get("sessionStorage")?.enumerable ?? true, value: memoryStorage() });
  } catch (error) {
    restoreProperty(host, "localStorage", descriptors.get("localStorage"));
    restoreProperty(host, "sessionStorage", descriptors.get("sessionStorage"));
    throw new Error("Herdgate Console could not install its tab-local storage guard", { cause: error });
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restoreProperty(host, "localStorage", descriptors.get("localStorage"));
    restoreProperty(host, "sessionStorage", descriptors.get("sessionStorage"));
  };
}
