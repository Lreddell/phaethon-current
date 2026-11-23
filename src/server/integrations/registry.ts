export type Capability = "mail.accounts" | "mail.search" | "mail.read" | "mail.compose" | "mail.send";
export type CapabilityState =
  | "ready" | "not-installed" | "not-connected" | "permission" | "admin-consent"
  | "license" | "unsupported" | "offline" | "restricted" | "setup";

export type Health = { state: CapabilityState; reason?: string };

export class IntegrationFailure extends Error {
  constructor(readonly state: Exclude<CapabilityState, "ready">, message: string) {
    super(message);
  }
}

/** One registry per domain lets each adapter keep its own contract. */
export class Providers<K extends string, P> {
  #factories = new Map<K, () => P>();
  #instances = new Map<K, P>();

  register(id: K, factory: () => P) {
    if (this.#factories.has(id)) throw new Error(`Duplicate provider: ${id}`);
    this.#factories.set(id, factory);
    return this;
  }

  ids(): K[] {
    return [...this.#factories.keys()];
  }

  get(id: K): P {
    const existing = this.#instances.get(id);
    if (existing) return existing;
    const factory = this.#factories.get(id);
    if (!factory) throw new IntegrationFailure("unsupported", "This provider isn’t available.");
    const provider = factory();
    this.#instances.set(id, provider);
    return provider;
  }
}
