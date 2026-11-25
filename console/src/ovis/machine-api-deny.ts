export type OvisApiFunction = (...args: unknown[]) => Promise<never>;
export type ReadOnlyOvisMachineApi = Record<string, OvisApiFunction>;

/** Fail closed before any Ovis API transport can be reached in the Herdgate L1 component tree. */
export function createReadOnlyOvisMachineApi(): ReadOnlyOvisMachineApi {
  return new Proxy(Object.create(null) as ReadOnlyOvisMachineApi, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return (..._args: unknown[]) => Promise.reject(new Error(`Ovis machine API is disabled in Herdgate read-only mode: ${property}`));
    },
  });
}
