// herdgate for the Herdr app — a docked panel that pairs this machine to a herdgate
// cloud, publishes it, and (as the owner) approves other machines joining the herd.
//
// Official mod surface only (docs/mods.md, defaults/AGENTS.md "### UI" and
// "### The `herdr` module"):
//   - a mod is `mods/<name>/` with mod.json + main.js, written in gpui-kit — JS that
//     describes native GPUI elements (no HTML, no DOM, no Node APIs);
//   - `herdr` gives the app's data and commands (exec, appHome, readTextFile, notify,
//     theme, props); `fetch` and `localStorage` are available to a mod;
//   - timers are `cx.timer.after(ms, fn)` and `cx.timer.every(ms, (cx) => …)`;
//   - `herdr-app check <mod folder>` loads it once and reports errors.
//
// Division of labour: this panel owns the pairing conversation (mint a code with
// `fetch`, poll it, write the room token), the owner conversation (approve another
// machine's code with the account token), and delegates long-lived publishing to the
// same publisher the TUI plugin ships (`<root>/plugin/server/index.mjs serve`).
// One implementation, two surfaces.
//
// What it reaches: the network (the herdgate cloud), programs (`sh`, `node`), and files
// under ~/.config/herdr-app only. It never reads a terminal.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, readTextFile, notify, theme, props, window } from "herdr";

const BASE = `${appHome()}/herdgate`;
const SETTINGS = `${BASE}/settings.json`;
const ENV_FILE = `${BASE}/config/herdgate.env`;
const STATE_FILE = `${BASE}/state/pairing.json`;
const PID_FILE = `${BASE}/state/publisher.pid`;

const POLL_MS = 2_500;
const REFRESH_MS = 4_000;

/** `sh` with argv passed positionally: no value is ever interpolated into a script. */
const sh = (script, args = []) => exec("sh", ["-c", script, "sh", ...args]).catch(() => null);

const dirOf = (path) => (path.lastIndexOf("/") > 0 ? path.slice(0, path.lastIndexOf("/")) : ".");

/** The token is a secret: write it 0600, which `writeTextFile` cannot express. */
const writeSecret = (path, text) =>
  sh('umask 077; mkdir -p "$1"; printf "%s\\n" "$2" > "$3"', [dirOf(path), text, path]);

/** POSIX liveness probe — no Node APIs in this runtime. */
async function alive(pid) {
  if (!pid) return false;
  const r = await sh('kill -0 "$1" 2>/dev/null && printf alive', [String(pid)]);
  return r?.stdout === "alive";
}

function parseEnv(text) {
  const out = {};
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

async function readJson(path) {
  const text = await readTextFile(path).catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // a half-written file must never take the panel down
  }
}

export default class Herdgate extends View {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.settings = { cloud: "", root: "", name: "", accountToken: "", allowAct: false };
    this.paired = false;
    this.cloud = "";
    this.publisher = { pid: null, running: false };
    this.lastPublish = null;

    this.pending = null; // { code, url, expiresAt } while a code is waiting
    this.phase = "idle"; // idle | waiting | saving | error
    this.message = "";
    this.busy = { pair: false, publish: false, approve: false, save: false };
    this.notified = false;

    this.isWindows = false;
    try { this.isWindows = window()?.platform === "windows"; } catch { /* window() unavailable this early */ }

    this.cloudInput = InputState.new({ placeholder: "https://herd.example.com" });
    this.rootInput = InputState.new({ placeholder: "set by `npx @bom0792/herdgate setup-host`" });
    this.nameInput = InputState.new({ placeholder: "this-machine" });
    this.tokenInput = InputState.new({ placeholder: "account token — only for approving other machines" });
    this.codeInput = InputState.new({ placeholder: "the code its panel shows" });

    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });

    // A light poll keeps the panel honest; the mod stays alive while its block shows.
    cx.timer.every(REFRESH_MS, (cx) => {
      cx.spawn(async (cx) => {
        await this.refresh();
        cx.notify();
      });
    });
  }

  async load() {
    const s = await readJson(SETTINGS);
    if (s) this.settings = { cloud: s.cloud ?? "", root: s.root ?? "", name: s.name ?? "", accountToken: s.accountToken ?? "", allowAct: s.allowAct === true };
    await this.refresh();
  }

  /** Everything shown is read back from disk or the cloud — never assumed. */
  async refresh() {
    const env = parseEnv(await readTextFile(ENV_FILE).catch(() => null));
    this.paired = Boolean(env.HERDGATE_ROOM_TOKEN);
    this.cloud = env.HERDGATE_URL ?? this.settings.cloud ?? "";
    const pidText = (await readTextFile(PID_FILE).catch(() => null))?.trim();
    const pid = pidText ? Number(pidText) : null;
    this.publisher = { pid, running: await alive(pid) };
    const state = await readJson(STATE_FILE);
    this.lastPublish = state?.lastPublish ?? null;
  }

  async saveSettings(cx) {
    const cloud = (this.cloudInput.value() ?? "").trim().replace(/\/$/, "");
    const root = (this.rootInput.value() ?? "").trim().replace(/\/$/, "");
    const name = (this.nameInput.value() ?? "").trim();
    const accountToken = (this.tokenInput.value() ?? "").trim() || this.settings.accountToken;
    this.busy.save = true;
    this.settings = { cloud, root, name, accountToken };
    const body = JSON.stringify(this.settings, null, 2);
    await sh('umask 077; mkdir -p "$1"; printf "%s" "$2" > "$3"', [BASE, body, SETTINGS]);
    await this.refresh();
    this.busy.save = false;
    this.message = cloud ? "settings saved" : "a cloud URL is required";
    cx?.notify?.();
  }

  /** Flip the owner's switch for `act` (control) devices — the only way a paired
 *  device gets more than read. Takes effect on the next pair; the publisher
 *  re-reads settings on each request. */
  async toggleAct(cx) {
    const cur = await readJson(SETTINGS);
    const s = { cloud: "", root: "", name: "", accountToken: "", ...(cur ?? {}), ...this.settings };
    s.allowAct = s.allowAct !== true;
    await sh('umask 077; printf "%s" "$2" > "$3"', [BASE, JSON.stringify(s, null, 2), SETTINGS]);
    this.settings = s;
    this.message = s.allowAct
      ? "act devices allowed — new pairs can control (existing devices keep their scope)"
      : "act devices blocked — new pairs are read-only";
    cx?.notify?.();
  }

  // ---- pairing: mint, show, poll, write the token --------------------------

  pair(cx) {
    if (this.busy.pair) return;
    const cloud = (this.settings.cloud || this.cloudInput.value() || "").replace(/\/$/, "");
    if (!cloud) {
      this.phase = "error";
      this.message = "set the herdgate cloud URL first (Settings below)";
      cx?.notify?.();
      return;
    }
    this.busy.pair = true;
    this.phase = "waiting";
    this.message = "asking the cloud for a code…";
    cx?.notify?.();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`${cloud}/v1/agent/code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: this.settings.name || "herdr-app" }),
        });
        if (!res.ok) throw new Error(`the cloud answered HTTP ${res.status}`);
        const minted = await res.json();
        this.pending = { code: minted.code, url: minted.url, expiresAt: Date.now() + (minted.expiresIn ?? 600) * 1000 };
        this.message = "waiting for approve — open the dashboard, or another herdgate panel";
        this.notified = false;
        this.busy.pair = false;
        cx.notify();
        this.poll(cx, cloud, minted.code);
      } catch (e) {
        this.phase = "error";
        this.busy.pair = false;
        this.message = e instanceof Error ? e.message : String(e);
        cx.notify();
      }
    });
  }

  poll(cx, cloud, code) {
    cx.timer.after(POLL_MS, (cx) => {
      if (!this.pending || this.pending.code !== code || this.phase !== "waiting") return;
      if (Date.now() > this.pending.expiresAt) {
        this.pending = null;
        this.phase = "error";
        this.message = "the code expired — press Pair again";
        cx.notify();
        return;
      }
      cx.spawn(async (cx) => {
        try {
          const st = await (await fetch(`${cloud}/v1/agent/code/${code}/status`)).json();
          if (st.status === "approved" && st.roomToken) {
            this.phase = "saving";
            await writeSecret(ENV_FILE, `HERDGATE_URL=${cloud}\nHERDGATE_ROOM_TOKEN=${st.roomToken}`);
            this.pending = null;
            this.phase = "idle";
            this.message = `paired (room ${st.roomId}) — press Publish to connect`;
            if (!this.notified) {
              this.notified = true;
              notify({ title: "herdgate", body: "This Herdr is paired. Press Publish to connect.", level: "success" });
            }
            await this.refresh();
            cx.notify();
            return;
          }
          if (st.status === "unknown") {
            this.pending = null;
            this.phase = "error";
            this.message = "the code expired — press Pair again";
            cx.notify();
            return;
          }
          cx.notify();
          this.poll(cx, cloud, code); // still pending
        } catch {
          this.poll(cx, cloud, code); // a blip: try again
        }
      });
    });
  }

  cancel(cx) {
    this.pending = null;
    this.phase = "idle";
    this.message = "cancelled";
    cx.notify();
  }

  // ---- approving ANOTHER machine (owner action, no terminal needed) --------

  approveOther(cx) {
    if (this.busy.approve) return;
    const cloud = (this.settings.cloud || this.cloudInput.value() || "").replace(/\/$/, "");
    const token = (this.tokenInput.value() ?? "").trim() || this.settings.accountToken;
    const code = (this.codeInput.value() ?? "").trim();
    if (!cloud || !token || !code) {
      this.phase = "error";
      this.message = !cloud ? "set the cloud URL first" : !token ? "paste your account token (Settings)" : "enter the code the other machine shows";
      cx?.notify?.();
      return;
    }
    this.busy.approve = true;
    this.message = "approving…";
    cx?.notify?.();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`${cloud}/v1/agent/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ code }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `the cloud answered HTTP ${res.status}`);
        this.phase = "idle";
        this.message = `approved “${body.name ?? code}” — it appears here once its publisher connects`;
        notify({ title: "herdgate", body: `Machine “${body.name ?? code}” joined the herd.`, level: "success" });
      } catch (e) {
        this.phase = "error";
        this.message = e instanceof Error ? e.message : String(e);
      }
      this.busy.approve = false;
      cx.notify();
    });
  }

  // ---- publishing: delegate to the shared herdgate publisher ---------------

  publisherPath() {
    return this.settings.root ? `${this.settings.root}/plugin/server/index.mjs` : "";
  }

  startPublisher(cx) {
    if (this.isWindows) {
      this.phase = "error";
      this.message = "publishing this machine needs Linux/macOS for now (Windows host is coming) — pairing and approving below still work";
      cx.notify();
      return;
    }
    if (!this.paired) {
      this.phase = "error";
      this.message = "pair this machine first";
      cx.notify();
      return;
    }
    const index = this.publisherPath();
    if (!index) {
      this.phase = "error";
      this.message = "set the herdgate folder so the publisher can be found";
      cx.notify();
      return;
    }
    this.busy.publish = true;
    this.message = "starting publisher…";
    cx.notify();
    cx.spawn(async (cx) => {
      const found = await sh('[ -f "$1" ] && command -v node >/dev/null && printf yes', [index]);
      if (found?.stdout !== "yes") {
        this.phase = "error";
        this.busy.publish = false;
        this.message = `needs node on PATH and ${index}`;
        cx.notify();
        return;
      }
      // Detached, so closing the panel or the app does not end publishing.
      await sh(
        'HERDR_PLUGIN_ID=$1 HERDR_PLUGIN_CONFIG_DIR=$2 HERDR_PLUGIN_STATE_DIR=$3 nohup node "$4" serve >/dev/null 2>&1 &',
        ["dev.herdgate.host", `${BASE}/config`, `${BASE}/state`, index],
      );
      // The publisher writes its own pid file; give it a moment, then read the truth.
      cx.timer.after(1_200, (cx) => {
        cx.spawn(async (cx) => {
          await this.refresh();
          this.busy.publish = false;
          this.message = this.publisher.running ? "publisher started — this machine is live on the gate" : "the publisher did not start (see state/publisher.log)";
          this.phase = this.publisher.running ? "idle" : "error";
          cx.notify();
        });
      });
    });
  }

  stopPublisher(cx) {
    if (this.isWindows) {
      this.phase = "error";
      this.message = "no publisher can be running here (Windows host is coming)";
      cx.notify();
      return;
    }
    this.busy.publish = true;
    cx.spawn(async (cx) => {
      if (this.publisher.pid) await sh('kill "$1" 2>/dev/null; true', [String(this.publisher.pid)]);
      await sh('rm -f "$1"', [PID_FILE]);
      await this.refresh();
      this.busy.publish = false;
      this.message = "publisher stopped";
      cx.notify();
    });
  }

  // ---- view ----------------------------------------------------------------

  render(cx) {
    const t = theme();
    const line = (label, value, color) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(div().text_size(11.5).text_color(t.dim).child(label))
        .child(div().flex_1().truncate().text_size(12).text_color(color ?? t.foreground).child(value));

    const section = (label) => div().mt(2).text_size(9.5).font_semibold().text_color(t.dim).child(label);

    return v_flex()
      .id("herdgate-panel")
      .track_focus(this.h)
      .size_full()
      .min_h(0)
      .p(12)
      .gap(8)
      .bg(t.chrome)
      .text_color(t.foreground)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().flex_1().text_size(13).font_semibold().child("herdgate"))
          .child(
            div()
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(10.5)
              .bg(t.background)
              .text_color(this.publisher.running ? t.working : this.paired ? t.dim : t.muted)
              .child(this.publisher.running ? "live" : this.paired ? "paired" : "not paired"),
          ),
      )
      .child(line("cloud", this.cloud || "—"))
      .child(line("publisher", this.publisher.running ? `running · ${this.publisher.pid}` : "stopped", this.publisher.running ? t.working : t.muted))
      .when(Boolean(this.lastPublish?.summary), (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(`${this.lastPublish.summary.workspaces} spaces · ${this.lastPublish.summary.agents} agents · ${this.lastPublish.summary.herdr}`),
        ),
      )
      // The status banner: one place that always says what just happened or what is
      // expected next. Colored by phase so "did my click do anything?" has an answer.
      .child(
        v_flex()
          .id("hg-status")
          .min_h(30)
          .justify_center()
          .px(8)
          .py(4)
          .rounded(6)
          .bg(t.background)
          .child(
            div()
              .text_size(11.5)
              .text_color(this.phase === "error" ? t.accent : this.phase === "waiting" ? t.working : t.dim)
              .child(
                this.busy.pair || this.busy.publish || this.busy.approve || this.busy.save
                  ? (this.message || "working…") + " ⏳"
                  : this.message || "ready — Pair this machine, or approve another one below",
              ),
          ),
      )
      .child(section("THIS MACHINE"))
      .when(this.isWindows, (el) => el.child(div().text_size(10).text_color(t.dim).child("this machine can pair and approve others; publishing it needs Linux/macOS for now")))
      .child(this.pairingBlock(t, cx))
      .child(section("ADD ANOTHER MACHINE"))
      .child(this.approveBlock(t, cx))
      .child(section("SETTINGS"))
      .child(this.settingsBlock(t, cx));
  }

  pairingBlock(t, cx) {
    if (this.pending) {
      return v_flex()
        .id("hg-code")
        .gap(5)
        .child(div().text_size(11.5).text_color(t.muted).child("approve in your dashboard"))
        .child(div().text_size(22).font_semibold().text_color(t.accent).child(this.pending.code.replace(/^(.{4})/, "$1 ")))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(this.pending.url ?? ""))
        .child(
          h_flex().gap(6).child(this.button(t, "hg-cancel", "Cancel", (cx2) => this.cancel(cx2), { enabled: !this.busy.pair })),
        );
    }
    return h_flex()
      .id("hg-actions")
      .gap(6)
      .child(
        this.button(t, "hg-pair", this.busy.pair ? "pairing…" : this.paired ? "Pair again" : "Pair", (cx2) => this.pair(cx2), {
          primary: true,
          enabled: !this.busy.pair && !this.busy.save,
        }),
      )
      .child(
        this.button(t, "hg-publish", this.busy.publish ? "starting…" : "Publish", (cx2) => this.startPublisher(cx2), {
          enabled: this.paired && !this.publisher.running && !this.busy.publish,
        }),
      )
      .child(
        this.button(t, "hg-stop", "Stop", (cx2) => this.stopPublisher(cx2), {
          enabled: this.publisher.running && !this.busy.publish,
        }),
      );
  }

  approveBlock(t, cx) {
    return v_flex()
      .id("hg-approve")
      .gap(5)
      .child(div().text_size(10.5).text_color(t.dim).child("want another machine in the herd? on IT: npx @bom0792/herdgate setup-host → its herdgate panel → Pair — it shows a code. type that code here:"))
      .child(
        h_flex()
          .gap(6)
          .child(
            Input.new(this.codeInput)
              .id("hg-code-input")
              .flex_1()
              .h(28)
              .px(8)
              .items_center()
              .rounded(6)
              .border(1)
              .border_color(t.input)
              .bg(t.background)
              .text_size(11.5)
              .text_color(t.foreground),
          )
          .child(this.button(t, "hg-approve", this.busy.approve ? "approving…" : "Approve", (cx2) => this.approveOther(cx2), {
            primary: true,
            enabled: !this.busy.approve,
          })),
      );
  }

  settingsBlock(t, cx) {
    const field = (id, input, label) =>
      v_flex()
        .gap(2)
        .child(div().text_size(10).text_color(t.dim).child(label))
        .child(
          Input.new(input)
            .id(id)
            .h(26)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(t.input)
            .bg(t.background)
            .text_size(11.5)
            .text_color(t.foreground),
        );
    return v_flex()
      .id("hg-settings")
      .gap(6)
      .child(field("hg-cloud", this.cloudInput, "cloud URL"))
      .child(field("hg-root", this.rootInput, "herdgate folder"))
      .child(field("hg-name", this.nameInput, "this machine's name"))
      .child(field("hg-token", this.tokenInput, "account token (owner) — used to approve other machines"))
      .child(
        h_flex().justify_between().items_center().gap(6).child(
          div().text_size(10).text_color(t.dim).child("control (act) devices — let paired machines do more than read"),
        ).child(this.button(t, "hg-act", this.settings.allowAct ? "allowed" : "blocked", (c) => this.toggleAct(c))),
      )
      .child(
        h_flex().justify_between().items_center().child(
          div().text_size(9.5).text_color(t.dim).child("stored under the app's herdgate dir, mode 0600"),
        ).child(this.button(t, "hg-save", this.busy.save ? "saving…" : "Save", (c) => this.saveSettings(c), { enabled: !this.busy.save })),
      );
  }

  button(t, id, label, onClick, opts = {}) {
    const { primary = false, enabled = true } = opts;
    const bg = primary ? t.solid : t.input;
    const fg = primary ? t.solid_foreground : t.foreground;
    return h_flex()
      .id(id)
      .h(28)
      .px(12)
      .items_center()
      .rounded(6)
      .bg(bg)
      .text_color(fg)
      .text_size(11.5)
      .when(!enabled, (el) => el.opacity(0.4))
      .when(enabled, (el) => el.hover((s) => s.bg(primary ? bg : t.hover)))
      .cursor_pointer()
      .on_click((_e, c) => {
        if (enabled) onClick(c);
      })
      .child(label);
  }
}
