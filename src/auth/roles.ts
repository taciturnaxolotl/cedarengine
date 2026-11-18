/**
 * Who may do what, as data.
 *
 * A route declares the one capability it needs; a role is a set of them. The
 * role itself comes from indiko (the resource role it reports at
 * introspection) or from a minted token, and the same table decides both.
 */

export const CAPABILITIES = ["catalog", "people", "facts:write", "sync", "admin"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = {
  admin: ["catalog", "people", "facts:write", "sync", "admin"],
  editor: ["catalog", "people", "facts:write"],
  reader: ["catalog", "people"],
  limited: ["catalog", "people"],
  sync: ["catalog", "sync"],
} as const satisfies Record<string, readonly Capability[]>;

export type Role = keyof typeof ROLES;

export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && Object.hasOwn(ROLES, value);

export const can = (role: Role, capability: Capability): boolean =>
  (ROLES[role] as readonly Capability[]).includes(capability);
