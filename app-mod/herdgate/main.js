// herdgate for the Herdr app — a docked panel that pairs this machine to a herdgate
// cloud and shows honest publish state.
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
// `fetch`, poll it, write the room token) and delegates long-lived publishing to the
// same publisher the TUI plugin ships (`<root>/plugin/server/index.mjs serve`).
// One implementation, two surfaces.
//
// What it reaches: the network (the herdgate cloud), programs (`sh`, `node`), and files
// under ~/.config/herdr-app only. It never reads a terminal.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, readTextFile, notify, theme, props, shared, setShared } from "herdr";

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
    // The shipped tabs mod renders its panel buttons from shared("workspace.panels")
    // (the welcome may have fixed it to ["files","changes"] — the layout clone's new
    // default never applies then). Self-heal: join the list once, keeping whatever
    // the person chose.
    {
      const panels = shared("workspace.panels");
      const list = Array.isArray(panels) ? panels : ["files", "changes"];
      if (!list.includes("herdgate")) setShared("workspace.panels", [...list, "herdgate"]);
    }
    this.settings = { cloud: "", root: "", name: "" };
    this.paired = false;
    this.cloud = "";
    this.publisher = { pid: null, running: false };
    this.lastPublish = null;

    this.pending = null; // { code, url, expiresAt } while a code is waiting
    this.phase = "idle"; // idle | waiting | saving | error
    this.message = "";
    this.notified = false;

    this.cloudInput = InputState.new({ placeholder: "https://herd.example.com" });
    this.rootInput = InputState.new({ placeholder: "~/src/herdgate" });
    this.nameInput = InputState.new({ placeholder: "this-machine" });

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
    if (s) this.settings = { cloud: s.cloud ?? "", root: s.root ?? "", name: s.name ?? "" };
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
    this.settings = { cloud, root, name };
    const body = JSON.stringify(this.settings, null, 2);
    await sh('umask 077; mkdir -p "$1"; printf "%s" "$2" > "$3"', [BASE, body, SETTINGS]);
    await this.refresh();
    this.message = cloud ? "saved" : "a cloud URL is required";
    cx?.notify?.();
  }

  // ---- pairing: mint, show, poll, write the token --------------------------

  pair(cx) {
    if (this.phase === "waiting" || this.phase === "saving") return;
    const cloud = (this.settings.cloud || this.cloudInput.value() || "").replace(/\/$/, "");
    if (!cloud) {
      this.phase = "error";
      this.message = "set the herdgate cloud URL first";
      cx?.notify?.();
      return;
    }
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
        this.message = "approve this code in your herdgate dashboard";
        this.notified = false;
        cx.notify();
        this.poll(cx, cloud, minted.code);
      } catch (e) {
        this.phase = "error";
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

  // ---- publishing: delegate to the shared herdgate publisher ---------------

  publisherPath() {
    return this.settings.root ? `${this.settings.root}/plugin/server/index.mjs` : "";
  }

  startPublisher(cx) {
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
    this.message = "starting…";
    cx.notify();
    cx.spawn(async (cx) => {
      const found = await sh('[ -f "$1" ] && command -v node >/dev/null && printf yes', [index]);
      if (found?.stdout !== "yes") {
        this.phase = "error";
        this.message = `needs node and ${index}`;
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
          this.message = this.publisher.running ? "publisher started" : "the publisher did not start";
          this.phase = this.publisher.running ? "idle" : "error";
          cx.notify();
        });
      });
    });
  }

  stopPublisher(cx) {
    cx.spawn(async (cx) => {
      if (this.publisher.pid) await sh('kill "$1" 2>/dev/null; true', [String(this.publisher.pid)]);
      await sh('rm -f "$1"', [PID_FILE]);
      await this.refresh();
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
              .text_color(this.paired ? t.working : t.dim)
              .child(this.paired ? "paired" : "not paired"),
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
      .child(div().h(1).bg(t.border).my(2))
      .child(this.pairingBlock(t, cx))
      .child(div().h(1).bg(t.border).my(2))
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
        .child(this.button(t, "hg-cancel", "Cancel", t.input, t.foreground, (cx) => this.cancel(cx), true));
    }
    return h_flex()
      .id("hg-actions")
      .gap(6)
      .child(this.button(t, "hg-pair", this.paired ? "Pair again" : "Pair", t.solid, t.solid_foreground, (cx) => this.pair(cx), true))
      .child(this.button(t, "hg-publish", "Publish", t.input, t.foreground, (cx) => this.startPublisher(cx), this.paired && !this.publisher.running))
      .child(this.button(t, "hg-stop", "Stop", t.input, t.foreground, (cx) => this.stopPublisher(cx), this.publisher.running));
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
      .child(
        h_flex().justify_between().items_center().child(
          div().text_size(9.5).text_color(t.dim).child("token → config dir, mode 0600"),
        ).child(this.button(t, "hg-save", "Save", t.input, t.foreground, (c) => this.saveSettings(c), true)),
      );
  }

  button(t, id, label, bg, fg, onClick, enabled) {
    return h_flex()
      .id(id)
      .h(26)
      .px(10)
      .items_center()
      .rounded(6)
      .bg(bg)
      .text_color(fg)
      .text_size(11.5)
      .when(!enabled, (el) => el.opacity(0.4))
      .cursor_pointer()
      .on_click((_e, cx) => {
        if (enabled) onClick(cx);
      })
      .child(label);
  }
}
