/** /account: the one place to sign in, and where people mint personal tokens. */

import {
  api,
  finishSignIn,
  SignedOut,
  safeNext,
  session,
  signInConfig,
  signOut,
  startSignIn,
  usePastedToken,
} from "./web/session";

const body = document.getElementById("body") as HTMLElement;
const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");
const next = new URLSearchParams(location.search).get("next");

interface Me {
  name: string;
  role: string;
  client: string | null;
  capabilities: string[];
  masks: string[];
  personalTokens: { mintableRoles: string[]; maxDays: number } | null;
}

interface Token {
  id: number;
  label: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

async function gate(message?: string): Promise<void> {
  const cfg = await signInConfig();
  body.innerHTML = `
    <div class="gate">
      <h2>sign in</h2>
      ${message ? `<p class="err">${esc(message)}</p>` : ""}
      ${
        cfg
          ? `<button type="button" id="indiko">sign in with indiko</button>
        <hr>`
          : ""
      }
      <form id="paste">
        <label class="note" for="tok">${cfg ? "or paste" : "paste"} a token, for scripts and the break-glass admin</label>
        <input id="tok" type="password" autocomplete="off" placeholder="ce_… or BEARER_TOKEN" required />
        <button type="submit">use token</button>
      </form>
    </div>`;
  document
    .getElementById("indiko")
    ?.addEventListener("click", () =>
      startSignIn({ kind: "session", next: safeNext(next ?? "/account") }),
    );
  document.getElementById("paste")?.addEventListener("submit", (event) => {
    event.preventDefault();
    usePastedToken((document.getElementById("tok") as HTMLInputElement).value.trim());
    void boot();
  });
}

function tokenRows(tokens: Token[]): string {
  if (!tokens.length) return `<tr><td colspan="6" class="dim">None yet.</td></tr>`;
  return tokens
    .map((t) => {
      const expired = t.expiresAt && t.expiresAt < new Date().toISOString();
      const state = t.revokedAt ? "revoked" : expired ? "expired" : "live";
      return `<tr>
        <td>${esc(t.label)}</td><td>${esc(t.role)}</td>
        <td><span class="badge ${state}">${state}</span></td>
        <td class="dim">${when(t.expiresAt)}</td><td class="dim">${when(t.lastUsedAt)}</td>
        <td>${state === "live" ? `<button class="danger" data-revoke="${t.id}">revoke</button>` : ""}</td>
      </tr>`;
    })
    .join("");
}

async function personalSection(me: Me, minted?: { token: string; record: Token }): Promise<string> {
  if (!me.personalTokens) {
    const why =
      session()?.via === "indiko"
        ? "Personal tokens are switched off on this engine (it needs SECRET_KEY)."
        : "Personal tokens are minted by people, so sign in with indiko rather than a pasted token to make one.";
    return `<h2>personal tokens</h2><p class="note">${why}</p>`;
  }
  const { tokens } = await api<{ tokens: Token[] }>("/v1/me/tokens");
  const days = [7, 30, me.personalTokens.maxDays].filter((d, i, all) => all.indexOf(d) === i);
  return `
    <h2>personal tokens</h2>
    <p class="note">For your own scripts: <code>curl -H "authorization: Bearer ce_…"</code>. Each one stays tied to your indiko account. It acts with the role you pick, or less if your role is lowered, and stops working the moment your role is removed, if you revoke cedarengine's tokens app in indiko, when it expires, or after 30 days unused.</p>
    ${
      minted
        ? `<div class="secret"><b>${esc(minted.record.label)}</b> (${esc(minted.record.role)}): copy it now, it is never shown again.
             <code>${esc(minted.token)}</code><button type="button" class="quiet" id="copy">copy</button></div>`
        : ""
    }
    <form class="row" id="mint">
      <input type="text" name="label" placeholder="what it is for, e.g. my notes script" required maxlength="120" />
      <select name="role" aria-label="role">${me.personalTokens.mintableRoles
        .map((r) => `<option ${r === me.role ? "selected" : ""}>${esc(r)}</option>`)
        .join("")}</select>
      <select name="days" aria-label="lifetime">${days
        .map((d) => `<option value="${d}" ${d === 30 ? "selected" : ""}>${d} days</option>`)
        .join("")}</select>
      <button type="submit">mint</button>
    </form>
    <p class="note">Minting asks indiko to confirm once more; that sign-in is the one the token keeps.</p>
    <div class="wrap"><table>
      <thead><tr><th>label</th><th>role</th><th>state</th><th>expires</th><th>last used</th><th></th></tr></thead>
      <tbody>${tokenRows(tokens)}</tbody>
    </table></div>`;
}

async function render(minted?: { token: string; record: Token }, notice?: string): Promise<void> {
  const me = await api<Me>("/v1/me");
  const via = session()?.via === "indiko" ? "indiko" : "a pasted token";
  body.innerHTML = `
    ${notice ? `<p class="err">${esc(notice)}</p>` : ""}
    <div class="card"><dl>
      <dt>signed in as</dt><dd>${esc(me.name)}</dd>
      <dt>through</dt><dd>${via}${me.client ? ` <span class="dim">(${esc(me.client.split("/").pop())})</span>` : ""}</dd>
      <dt>role</dt><dd>${esc(me.role)}</dd>
      <dt>may</dt><dd class="dim">${me.capabilities.map(esc).join(", ")}</dd>
      <dt>hidden from you</dt><dd class="dim">${me.masks.length ? me.masks.map(esc).join(", ") : "nothing"}</dd>
    </dl></div>
    <nav class="links">
      <a href="/">dashboard</a>
      <a href="/map">campus map</a>
      ${me.role === "admin" ? `<a href="/admin">admin</a>` : ""}
      <a href="/openapi.json">openapi.json</a>
      <button type="button" class="quiet" id="signout">sign out</button>
    </nav>
    ${await personalSection(me, minted)}`;

  document.getElementById("signout")?.addEventListener("click", () => {
    signOut();
    void gate();
  });
  document.getElementById("copy")?.addEventListener("click", (event) => {
    void navigator.clipboard.writeText(minted!.token);
    (event.target as HTMLElement).textContent = "copied";
  });
  document.getElementById("mint")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    void startSignIn({
      kind: "mint",
      label: String(form.get("label")),
      role: String(form.get("role")),
      days: Number(form.get("days")),
    });
  });
  for (const button of body.querySelectorAll<HTMLButtonElement>("[data-revoke]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.confirm !== "1") {
        button.dataset.confirm = "1";
        button.textContent = "revoke? click again";
        return;
      }
      await api(`/v1/me/tokens/${button.dataset.revoke}/revoke`, { method: "POST" });
      await render();
    });
  }
}

async function boot(): Promise<void> {
  try {
    const returned = await finishSignIn();
    if (returned.kind === "error") return gate(returned.message);
    if (!session()) return gate();

    // Check the session works before leaving, so a refusal is explained here, not as a bare error elsewhere.
    const leaveFor =
      returned.kind === "session"
        ? returned.next
        : returned.kind === "none" && next
          ? safeNext(next)
          : null;
    if (leaveFor && leaveFor !== "/account") {
      await api("/v1/me");
      return location.replace(leaveFor);
    }

    if (returned.kind === "mint") {
      try {
        const minted = await api<{ token: string; record: Token }>("/v1/me/tokens", {
          method: "POST",
          body: {
            label: returned.label,
            role: returned.role,
            expiresInDays: returned.days,
            code: returned.code,
            codeVerifier: returned.verifier,
          },
        });
        return render(minted);
      } catch (error) {
        if (error instanceof SignedOut) throw error;
        return render(undefined, error instanceof Error ? error.message : String(error));
      }
    }
    await render();
  } catch (error) {
    if (error instanceof SignedOut)
      return gate(`cedarengine refused the sign-in: ${error.message}`);
    body.innerHTML = `<p class="err">${esc(error instanceof Error ? error.message : error)}</p>`;
  }
}

void boot();
