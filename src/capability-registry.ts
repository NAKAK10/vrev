export interface CapabilityReference {
  readonly id: string;
  readonly apiVersion: number;
}

export class CapabilityUnavailableError extends Error {
  readonly capabilityId: string;
  readonly apiVersion: number;

  constructor(id: string, apiVersion: number) {
    super(`capability ${id} API version ${apiVersion} is unavailable`);
    this.name = "CapabilityUnavailableError";
    this.capabilityId = id;
    this.apiVersion = apiVersion;
  }
}

/**
 * Host-owned registry for versioned capability ports. Implementations remain
 * opaque, so consumers do not need to import another plugin's implementation.
 */
export class CapabilityRegistry {
  private readonly entries = new Map<string, Map<number, unknown>>();

  register<T>(id: string, apiVersion: number, implementation: T): () => void {
    assertReference(id, apiVersion);
    if (implementation === undefined || implementation === null) {
      throw new Error("capability implementation must be defined");
    }
    let versions = this.entries.get(id);
    if (versions === undefined) {
      versions = new Map<number, unknown>();
      this.entries.set(id, versions);
    }
    if (versions.has(apiVersion)) {
      throw new Error(`capability ${id} API version ${apiVersion} is already registered`);
    }
    versions.set(apiVersion, implementation);

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (versions!.get(apiVersion) !== implementation) return;
      versions!.delete(apiVersion);
      if (versions!.size === 0) this.entries.delete(id);
    };
  }

  has(id: string, apiVersion: number): boolean {
    assertReference(id, apiVersion);
    return this.entries.get(id)?.has(apiVersion) ?? false;
  }

  resolve<T>(id: string, apiVersion: number): T {
    assertReference(id, apiVersion);
    const versions = this.entries.get(id);
    if (versions === undefined || !versions.has(apiVersion)) {
      throw new CapabilityUnavailableError(id, apiVersion);
    }
    return versions.get(apiVersion) as T;
  }
}

function assertReference(id: string, apiVersion: number): void {
  if (!id.trim() || id !== id.trim()) throw new Error("capability id must be nonblank and trimmed");
  if (!Number.isSafeInteger(apiVersion) || apiVersion < 1) {
    throw new Error("capability apiVersion must be a positive integer");
  }
}
