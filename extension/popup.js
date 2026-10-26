/**
 * Setup and a live view of the sweep.
 *
 * Paste the URL and the token, press Save. Saving asks for permission to talk
 * to whatever host you named, because the engine is usually on localhost or a
 * tunnel and neither can be baked into the manifest. Once a sync is running the
 * panel follows it in real time off the status the background writes to storage.
 */

const FIELDS = ["engine", "token", "term", "everyHours"];
const el = (id) => document.getElementById(id);
const status = el("status");
const phase = el("phase");
const bar = el("bar");

const send = (message) =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok) return reject(new Error(reply?.error ?? "no answer"));
      resolve(reply.result);
    }),
  );

const PHASES = {
  signin: "sign in",
  directory: "directory",
  catalog: "catalog",
  booklists: "booklists",
  idle: "idle",
};

const plural = (n, one) => {
  const many = { query: "queries", person: "people" }[one] ?? `${one}s`;
  return `${n} ${n === 1 ? one : many}`;
};
const ago = (at) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(at).toLocaleString();
};

/** done / (done + left) as a whole-number percent, or null when unknowable. */
const pct = (done, left) => {
  const total = (done ?? 0) + (left ?? 0);
  return total > 0 ? Math.round(((done ?? 0) / total) * 100) : null;
};

/** The lines and the bar for one status snapshot. */
function view(state) {
  if (!state || !state.phase)
    return { label: "", lines: ["configure the engine url and token to begin"] };

  const lines = [];
  let fill = null;

  switch (state.phase) {
    case "signin":
      lines.push(state.note ?? "waiting for Self-Service sign-in…");
      break;

    case "directory":
      if (state.note) lines.push(state.note);
      if (state.asked != null) {
        lines.push(`${plural(state.asked, "query")} asked · ${state.queued ?? 0} queued`);
        fill = pct(state.asked, state.queued);
      }
      if (state.added) lines.push(`+${plural(state.added, "person")}`);
      break;

    case "catalog":
      lines.push(`${state.term ?? ""}${state.page ? ` · ${state.page}` : ""}`.trim() || "working…");
      break;

    case "booklists":
      if (state.note) lines.push(state.note);
      if (state.collected != null) {
        lines.push(
          `${plural(state.collected, "booklist")}${state.queued != null ? ` · ${state.queued} left` : ""}`,
        );
        fill = pct(state.collected, state.queued);
      }
      break;

    default: {
      // idle — the standing report of the last run.
      const when = state.at ? ago(state.at) : null;
      const bits = [];
      if (state.asked) bits.push(`${plural(state.asked, "query")}`);
      if (state.added) bits.push(`+${plural(state.added, "person")}`);
      if (state.terms) bits.push(`${plural(state.terms, "term")}`);
      if (state.collected) bits.push(`${plural(state.collected, "booklist")}`);
      if (bits.length) lines.push(bits.join(" · "));
      if (when) lines.push(`last sync ${when}`);
      if (state.failed?.length) lines.push(`catalog missed: ${state.failed.join(" ")}`);
      if (state.catalogError) lines.push(`catalog: ${state.catalogError}`);
      if (!lines.length) lines.push("idle");
    }
  }

  return { label: PHASES[state.phase] ?? state.phase, lines, fill, error: state.error };
}

function render(state) {
  const { label, lines, fill, error } = view(state ?? {});
  const running = state?.phase && state.phase !== "idle";

  phase.textContent = label;
  phase.className = "phase" + (running ? " live" : "");

  status.textContent = (error ? [error, ...lines] : lines).join("\n");
  status.classList.toggle("err", Boolean(error));

  if (fill == null) {
    bar.style.display = "none";
  } else {
    bar.style.display = "block";
    bar.firstElementChild.style.width = `${fill}%`;
  }
}

// ── live: follow the background's status as it writes it ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.status) render(changes.status.newValue);
});

const stored = await chrome.storage.local.get(null);
for (const field of FIELDS) el(field).value = stored[field] ?? "";
el("engine").value = stored.engine ?? "http://127.0.0.1:3000";
el("everyHours").value = stored.everyHours ?? 12;
el("autoSync").checked = stored.autoSync ?? true;

async function save() {
  const values = Object.fromEntries(FIELDS.map((field) => [field, el(field).value.trim()]));
  values.everyHours = Number(values.everyHours) || 12;
  values.autoSync = el("autoSync").checked;

  // The engine's host is whatever you typed, so permission has to be asked for
  // at that point rather than declared up front.
  const origin = `${new URL(values.engine).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    render({ phase: "idle", error: "without permission for that host, nothing can be posted" });
    return;
  }

  await chrome.storage.local.set(values);
  try {
    const manifest = await send({ type: "manifest" });
    phase.textContent = "ready";
    phase.className = "phase";
    bar.style.display = "none";
    status.classList.remove("err");
    status.textContent = [
      `connected · term ${manifest.term}`,
      `${manifest.directory.pending} directory queries pending`,
      `${manifest.booklists.remaining} students without a booklist`,
    ].join("\n");
  } catch (error) {
    render({ phase: "idle", error: error.message });
  }
}

const run = (type) => async () => {
  render({ phase: type === "sync" ? "directory" : type, note: "starting…" });
  try {
    const result = await send({ type });
    render(result); // the resolved value is the final status snapshot
  } catch (error) {
    render({ phase: "idle", error: error.message });
  }
};

el("save").onclick = save;
el("sync").onclick = run("sync");
el("directory").onclick = run("directory");
el("catalog").onclick = run("catalog");
el("booklists").onclick = run("booklists");

// Open onto whatever the last known state was.
try {
  render(await send({ type: "status" }));
} catch {
  render(null);
}
