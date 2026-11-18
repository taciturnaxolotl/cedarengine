/**
 * The admin page: tokens, role masks, the audit log and canary hits.
 *
 * Signing in happens at /account; this page uses that session and sends
 * anyone without one there first.
 */

import { api, requireSignIn, SignedOut, session, signOut } from "./web/session";

const body = document.getElementById("body") as HTMLElement;

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

// --- tabs ---------------------------------------------------------------------

interface Token {
  id: number;
  label: string;
  role: string;
  canary: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  ownerName: string | null;
}

interface Roles {
  roles: { role: string; capabilities: string[]; masks: string[]; editable: boolean }[];
  masks: {
    id: string;
    label: string;
    builtin: boolean;
    fields: string[];
    routes: string[];
    filters: string[];
  }[];
  maskable: {
    fields: string[];
    routes: string[];
    filters: string[];
    routeFilters: Record<string, string[]>;
  };
  indiko: { url: string; audience: string } | null;
}

interface AuditRow {
  at: string;
  actor: string;
  actorName: string;
  role: string;
  client: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  userAgent: string | null;
  canary: boolean;
}

const TABS = {
  tokens: "tokens",
  roles: "roles & masks",
  audit: "audit log",
  canaries: "canaries",
} as const;
type Tab = keyof typeof TABS;

let me: { name: string; role: string } | undefined;

function shell(active: Tab): HTMLElement {
  body.innerHTML = `
    <nav class="tabs">${Object.entries(TABS)
      .map(
        ([id, label]) =>
          `<a href="#${id}" ${id === active ? 'aria-current="page"' : ""}>${label}</a>`,
      )
      .join("")}</nav>
    <div id="tab"></div>`;
  return document.getElementById("tab") as HTMLElement;
}

function showError(el: HTMLElement, error: unknown): void {
  const note = document.createElement("p");
  note.className = "err";
  note.textContent = error instanceof Error ? error.message : String(error);
  el.prepend(note);
}

async function tokensTab(
  el: HTMLElement,
  minted?: { token: string; record: Token },
): Promise<void> {
  const [{ tokens }, { roles }] = await Promise.all([
    api<{ tokens: Token[] }>("/v1/admin/tokens"),
    api<Roles>("/v1/admin/roles"),
  ]);
  const rows = tokens.length
    ? tokens
        .map((t) => {
          const expired = t.expiresAt && t.expiresAt < new Date().toISOString();
          const state = t.revokedAt
            ? "revoked"
            : expired
              ? "expired"
              : t.canary
                ? "canary"
                : "live";
          const revoke = t.revokedAt
            ? ""
            : `<button class="danger" data-revoke="${t.id}" data-label="${esc(t.label)}">revoke</button>`;
          return `<tr>
            <td>${t.id}</td>
            <td>${esc(t.label)}${t.ownerName ? `<div class="dim">personal · ${esc(t.ownerName)}</div>` : ""}</td>
            <td>${esc(t.role)}</td>
            <td><span class="badge ${state}">${state}</span></td>
            <td class="dim">${when(t.createdAt)}${t.expiresAt ? `<div>expires ${when(t.expiresAt)}</div>` : ""}</td>
            <td class="dim">${when(t.lastUsedAt)}</td>
            <td>${revoke} <a href="#audit?actor=token:${t.id}">activity</a></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="dim">No tokens yet. Mint one for each script that needs access.</td></tr>`;

  el.innerHTML = `
    <h2>minted tokens</h2>
    <p class="note">For shared scripts, bots and the CLI. People mint their own personal tokens at /account, which follow their indiko role live; those show here too, marked personal. A canary is a token planted to be stolen: it sees invented people and every use shows up under canaries.</p>
    <form class="row" id="mint">
      <input type="text" name="label" placeholder="label, e.g. assassins bot" required maxlength="120" />
      <select name="role">${roles
        .map((r) => `<option ${r.role === "reader" ? "selected" : ""}>${esc(r.role)}</option>`)
        .join("")}</select>
      <label class="row" style="margin:0"><input type="checkbox" name="canary" /> canary</label>
      <button type="submit">mint</button>
    </form>
    ${
      minted
        ? `<div class="secret">
            <b>${esc(minted.record.label)}</b> (${esc(minted.record.role)}${minted.record.canary ? ", canary" : ""}): copy it now, it is never shown again.
            <code>${esc(minted.token)}</code>
            <button type="button" class="quiet" id="copy">copy</button>
          </div>`
        : ""
    }
    <div class="wrap"><table>
      <thead><tr><th>id</th><th>label</th><th>role</th><th>state</th><th>created</th><th>last used</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  document.getElementById("copy")?.addEventListener("click", (event) => {
    void navigator.clipboard.writeText(minted!.token);
    (event.target as HTMLElement).textContent = "copied";
  });

  el.querySelector("#mint")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    try {
      const created = await api<{ token: string; record: Token }>("/v1/admin/tokens", {
        method: "POST",
        body: {
          label: form.get("label"),
          role: form.get("role"),
          canary: form.get("canary") === "on",
        },
      });
      await tokensTab(el, created);
    } catch (error) {
      showError(el, error);
    }
  });

  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-revoke]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.confirm !== "1") {
        button.dataset.confirm = "1";
        button.textContent = `revoke ${button.dataset.label}? click again`;
        return;
      }
      try {
        await api(`/v1/admin/tokens/${button.dataset.revoke}/revoke`, { method: "POST" });
        await tokensTab(el);
      } catch (error) {
        showError(el, error);
      }
    });
  }
}

function customMasks(masks: Roles["masks"], maskable: Roles["maskable"]): string {
  const custom = masks.filter((m) => !m.builtin);
  const describe = (m: Roles["masks"][number]) =>
    [
      m.fields.length ? `fields: ${m.fields.join(", ")}` : "",
      m.routes.length ? `routes: ${m.routes.join(", ")}` : "",
      m.filters.length ? `filters: ${m.filters.join(", ")}` : "",
    ]
      .filter(Boolean)
      .map(esc)
      .join("<br />");
  return `
    <h2>custom masks</h2>
    <p class="note">Build a mask from the person fields, routes and search filters the engine knows. It appears as a row in the grid above; tick it for a role to apply it. A mask must be unticked everywhere before it can be deleted, so deleting never unhides anything.</p>
    <div class="wrap"><table>
      <thead><tr><th>id</th><th>label</th><th>hides</th><th></th></tr></thead>
      <tbody>${
        custom.length
          ? custom
              .map(
                (
                  m,
                ) => `<tr><td>${esc(m.id)}</td><td>${esc(m.label)}</td><td class="dim">${describe(m)}</td>
                  <td><button class="quiet" data-edit-mask="${esc(m.id)}">edit</button>
                  <button class="danger" data-delete-mask="${esc(m.id)}">delete</button></td></tr>`,
              )
              .join("")
          : `<tr><td colspan="4" class="dim">None yet.</td></tr>`
      }</tbody>
    </table></div>
    <form id="mask-form">
      <div class="row">
        <input type="text" name="id" placeholder="id, e.g. no-department" required pattern="[a-z][a-z0-9-]{1,31}" />
        <input type="text" name="label" placeholder="label shown in the grid" required maxlength="120" />
        <button type="submit">save mask</button>
      </div>
      ${maskTree(maskable)}
    </form>`;
}

/** The person object written out as JSON, one checkbox per key. */
function personJson(fields: string[]): string {
  const rows = fields
    .map(
      (f, at) => `<li><label><input type="checkbox" name="fields" value="${esc(f)}" />
        <span class="key">"${esc(f)}"</span><span class="punct">:</span>
        <span class="type">string | null</span>${at < fields.length - 1 ? '<span class="punct">,</span>' : ""}</label></li>`,
    )
    .join("");
  return `
    <div class="json">
      <label><input type="checkbox" data-all-fields /> <span class="punct">{</span>
        <span class="dim">every field</span></label>
      <ul><li><span class="punct key-id">"id": string, <span class="dim">always kept</span></span></li>${rows}</ul>
      <span class="punct">}</span>
    </div>`;
}

/** Routes grouped by their resource, each with the search filters it accepts. */
function routeSections(maskable: Roles["maskable"]): string {
  const groups = new Map<string, string[]>();
  for (const route of maskable.routes) {
    const resource = route.split("/")[2] ?? "";
    groups.set(resource, [...(groups.get(resource) ?? []), route]);
  }
  return [...groups]
    .map(
      ([resource, routes]) => `
        <fieldset class="section">
          <legend>${esc(resource)}</legend>
          ${routes
            .map((route) => {
              const filters = (maskable.routeFilters[route] ?? [])
                .map(
                  (f) =>
                    `<label class="chip"><input type="checkbox" name="filters" value="${esc(f)}" data-sync="${esc(f)}" /> ?${esc(f)}</label>`,
                )
                .join("");
              return `<div class="route"><label><input type="checkbox" name="routes" value="${esc(route)}" />
                <span class="key">${esc(route)}</span></label>${filters ? `<span class="chips">${filters}</span>` : ""}</div>`;
            })
            .join("")}
        </fieldset>`,
    )
    .join("");
}

function maskTree(maskable: Roles["maskable"]): string {
  return `
    <p class="note">person fields: stripped wherever a person appears, in search results and lookups alike</p>
    ${personJson(maskable.fields)}
    <p class="note">routes: a ticked route answers 403; a ticked <code>?filter</code> is refused on every route that takes it</p>
    ${routeSections(maskable)}`;
}

/** Keep the tree's composite boxes honest: duplicated filters match, the person box reflects its fields. */
function wireTree(form: HTMLFormElement): void {
  const fields = [...form.querySelectorAll<HTMLInputElement>('input[name="fields"]')];
  const all = form.querySelector<HTMLInputElement>("input[data-all-fields]");
  const syncAll = () => {
    if (!all) return;
    const ticked = fields.filter((f) => f.checked).length;
    all.checked = ticked === fields.length;
    all.indeterminate = ticked > 0 && ticked < fields.length;
  };
  all?.addEventListener("change", () => {
    for (const field of fields) field.checked = all.checked;
  });
  for (const field of fields) field.addEventListener("change", syncAll);
  for (const filter of form.querySelectorAll<HTMLInputElement>("input[data-sync]")) {
    filter.addEventListener("change", () => {
      for (const twin of form.querySelectorAll<HTMLInputElement>(
        `input[data-sync="${CSS.escape(filter.value)}"]`,
      )) {
        twin.checked = filter.checked;
      }
    });
  }
  syncAll();
  form.addEventListener("reset", () => queueMicrotask(syncAll));
  form.addEventListener("tree-loaded", syncAll);
}

async function rolesTab(el: HTMLElement): Promise<void> {
  const { roles, masks, maskable, indiko } = await api<Roles>("/v1/admin/roles");
  const where = indiko
    ? `People's roles are assigned in indiko, on the resource <code>${esc(indiko.audience)}</code> (<a href="${esc(indiko.url)}/admin/resources" target="_blank" rel="noopener">open indiko</a>). Minted tokens carry the role they were minted with.`
    : "Indiko sign-in is off (INDIKO_URL unset), so only minted tokens and BEARER_TOKEN get in.";
  el.innerHTML = `
    <h2>roles</h2>
    <p class="note">${where}</p>
    <div class="wrap"><table>
      <thead><tr><th>role</th><th>may</th></tr></thead>
      <tbody>${roles
        .map(
          (r) =>
            `<tr><td>${esc(r.role)}</td><td class="dim">${r.capabilities.map(esc).join(", ")}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <h2>masks</h2>
    <p class="note">A ticked box hides that group from the role: its fields are stripped, its routes answer 403 and its search filters are refused. Admin is never masked. Changes apply to the next request.</p>
    <div class="wrap"><table>
      <thead><tr><th>hidden from…</th>${roles.map((r) => `<th class="c">${esc(r.role)}</th>`).join("")}</tr></thead>
      <tbody>${masks
        .map(
          (m) =>
            `<tr><td>${esc(m.label)}</td>${roles
              .map(
                (
                  r,
                ) => `<td class="c"><input type="checkbox" data-role="${esc(r.role)}" value="${esc(m.id)}"
                ${r.masks.includes(m.id) ? "checked" : ""} ${r.editable ? "" : "disabled"}
                aria-label="hide ${esc(m.label)} from ${esc(r.role)}" /></td>`,
              )
              .join("")}</tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <p class="note" id="saved"></p>
    ${customMasks(masks, maskable)}`;

  for (const box of el.querySelectorAll<HTMLInputElement>("input[data-role]")) {
    box.addEventListener("change", async () => {
      const role = box.dataset.role!;
      const chosen = [
        ...el.querySelectorAll<HTMLInputElement>(`input[data-role="${role}"]:checked`),
      ].map((b) => b.value);
      try {
        const saved = await api<{ masks: string[] }>(`/v1/admin/roles/${role}/masks`, {
          method: "POST",
          body: { masks: chosen },
        });
        (el.querySelector("#saved") as HTMLElement).textContent =
          `${role} now hides: ${saved.masks.join(", ") || "nothing"}`;
      } catch (error) {
        box.checked = !box.checked;
        showError(el, error);
      }
    });
  }

  wireTree(el.querySelector<HTMLFormElement>("#mask-form")!);
  el.querySelector("#mask-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    try {
      await api("/v1/admin/masks", {
        method: "POST",
        body: {
          id: form.get("id"),
          label: form.get("label"),
          fields: form.getAll("fields"),
          routes: form.getAll("routes"),
          filters: [...new Set(form.getAll("filters"))],
        },
      });
      await rolesTab(el);
    } catch (error) {
      showError(el, error);
    }
  });
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-delete-mask]")) {
    button.addEventListener("click", async () => {
      try {
        await api(`/v1/admin/masks/${button.dataset.deleteMask}/delete`, { method: "POST" });
        await rolesTab(el);
      } catch (error) {
        showError(el, error);
      }
    });
  }
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-edit-mask]")) {
    button.addEventListener("click", () => {
      const mask = masks.find((m) => m.id === button.dataset.editMask)!;
      const form = el.querySelector<HTMLFormElement>("#mask-form")!;
      (form.elements.namedItem("id") as HTMLInputElement).value = mask.id;
      (form.elements.namedItem("label") as HTMLInputElement).value = mask.label;
      for (const box of form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
        if (box.name) {
          box.checked = (mask[box.name as "fields" | "routes" | "filters"] ?? []).includes(
            box.value,
          );
        }
      }
      form.dispatchEvent(new Event("tree-loaded"));
      form.scrollIntoView({ behavior: "smooth" });
    });
  }
}

async function auditTab(
  el: HTMLElement,
  filters: Record<string, string>,
  canaryOnly: boolean,
): Promise<void> {
  const params = new URLSearchParams(filters);
  if (canaryOnly) params.set("canary", "1");
  params.set("limit", "100");
  const { total, rows } = await api<{ total: number; rows: AuditRow[] }>(
    `/v1/admin/audit?${params}`,
  );
  const field = (name: string, placeholder: string) =>
    `<input type="text" name="${name}" placeholder="${placeholder}" value="${esc(filters[name] ?? "")}" />`;
  const empty = canaryOnly ? "No canary has been touched." : "Nothing matches.";

  el.innerHTML = `
    <h2>${canaryOnly ? "canary hits" : "audit log"}</h2>
    <p class="note">${
      canaryOnly
        ? "Requests made with canary tokens. Whoever made them was shown invented people; the address and client are theirs."
        : "Every authenticated request, newest first."
    }</p>
    <form class="row" id="filter">
      ${field("actor", "actor, e.g. token:3")}
      ${field("path", "path contains, e.g. a person id")}
      ${field("since", "since, e.g. 2026-11-01")}
      <button type="submit">filter</button>
      <button type="button" class="quiet" id="clear">clear</button>
    </form>
    <p class="note">${total} matching, showing the newest ${rows.length}</p>
    <div class="wrap"><table>
      <thead><tr><th>when</th><th>who</th><th>role</th><th>request</th><th>status</th><th>from</th></tr></thead>
      <tbody>${
        rows.length
          ? rows
              .map(
                (r) => `<tr class="${r.canary ? "canary" : ""}">
                  <td class="dim">${when(r.at)}</td>
                  <td><button class="quiet" data-actor="${esc(r.actor)}">${esc(r.actorName)}</button>
                    ${r.client ? `<div class="dim">${esc(r.client.split("/").pop())}</div>` : ""}</td>
                  <td>${esc(r.role)}</td>
                  <td>${esc(r.method)} ${esc(r.path)}</td>
                  <td>${r.status}</td>
                  <td class="dim">${esc(r.ip ?? "")}<div>${esc((r.userAgent ?? "").slice(0, 40))}</div></td>
                </tr>`,
              )
              .join("")
          : `<tr><td colspan="6" class="dim">${empty}</td></tr>`
      }</tbody>
    </table></div>`;

  const tab = canaryOnly ? "canaries" : "audit";
  const go = (next: Record<string, string>) => {
    const query = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
    location.hash = query ? `${tab}?${query}` : tab;
  };
  el.querySelector("#filter")?.addEventListener("submit", (event) => {
    event.preventDefault();
    go(Object.fromEntries(new FormData(event.target as HTMLFormElement)) as Record<string, string>);
  });
  el.querySelector("#clear")?.addEventListener("click", () => go({}));
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-actor]")) {
    button.addEventListener("click", () => go({ actor: button.dataset.actor! }));
  }
}

async function route(): Promise<void> {
  const [name, query] = (location.hash.slice(1) || "tokens").split("?");
  const active: Tab = name && name in TABS ? (name as Tab) : "tokens";
  const el = shell(active);
  const filters = Object.fromEntries(new URLSearchParams(query ?? ""));
  try {
    if (active === "tokens") await tokensTab(el);
    if (active === "roles") await rolesTab(el);
    if (active === "audit") await auditTab(el, filters, false);
    if (active === "canaries") await auditTab(el, filters, true);
  } catch (error) {
    if (error instanceof SignedOut) requireSignIn();
    showError(el, error);
  }
}

async function boot(): Promise<void> {
  if (!session()) requireSignIn();
  try {
    me = await api<{ name: string; role: string }>("/v1/me");
  } catch (error) {
    if (error instanceof SignedOut) requireSignIn();
    throw error;
  }
  (document.getElementById("who") as HTMLElement).textContent = `${me.name} (${me.role})`;
  if (me.role !== "admin") {
    body.innerHTML = `<p class="err">Signed in as ${esc(me.name)} with the ${esc(me.role)} role; this page needs admin.</p>
      <p><a href="/account">your account</a></p>`;
    return;
  }
  await route();
}

window.addEventListener("hashchange", () => {
  if (me?.role === "admin") void route();
});
document.getElementById("signout")?.addEventListener("click", () => {
  signOut();
  location.assign("/account");
});
void boot();
