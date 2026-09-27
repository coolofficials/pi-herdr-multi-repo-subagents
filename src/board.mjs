import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readJSON, writeJSON } from "./storage.mjs";
import { familyRecords } from "./views.mjs";
import { executionState } from "./execution.mjs";
import { liveness } from "./lifecycle.mjs";
import { herdr } from "./core.mjs";

export async function boardSnapshot(scope) {
  const parent = await readJSON(path.join(scope, "parent.json"));
  const rows = [];
  for (const record of await familyRecords(scope)) {
    const state = await executionState(record);
    const work =
      record.bundle &&
      (await readJSON(path.join(scope, "work", record.bundle + ".json")));
    const closed = await readJSON(path.join(record.dir, "view-closed.json"));
    rows.push({
      id: record.id,
      dir: record.dir,
      pane: record.pane,
      tab: record.tab,
      bundle: record.bundle,
      label: record.label ?? record.repo,
      task: work?.title,
      status: closed ? "closed" : state.phase,
      taskStatus: work?.status,
      live: state.ready?.instance ? liveness(state.ready.instance) : "unknown",
      keep: Boolean((await readJSON(path.join(record.dir, "keep.json")))?.keep),
      report: state.report,
      sessionFile: state.ready?.sessionFile,
      usage: await readJSON(path.join(record.dir, "context-pressure.json")),
    });
  }
  return { parent, rows };
}
const wrap = (line, width) => {
  const lines = [];
  let current = "",
    size = 0;
  for (const ch of clean(line)) {
    const n =
      /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(
        ch,
      )
        ? 2
        : 1;
    if (size + n > width) {
      lines.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  lines.push(current);
  return lines;
};
const clean = (text) =>
  String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export async function runBoard(scope) {
  if (process.env.HERDR_ENV !== "1")
    throw Error("Board requires a genuine Herdr pane.");
  let snapshot = { rows: [], parent: null },
    selected = 0,
    showClosed = true,
    detail = false,
    offset = 0,
    input = null,
    note = "",
    busy = false,
    done = false;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const exit = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    process.stdin.setRawMode?.(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.exit(0);
  };
  const visible = () =>
    snapshot.rows.filter((r) => showClosed || r.status !== "closed");
  function draw() {
    const rows = visible(),
      width = Math.max(20, process.stdout.columns ?? 60),
      height = Math.max(8, process.stdout.rows ?? 24);
    selected = Math.max(0, Math.min(selected, rows.length - 1));
    const row = rows[selected];
    let lines = [
      "REPOSITORY WORK",
      snapshot.parent?.status === "active"
        ? "Live · no model polling"
        : "Owner ended · saved history",
      "↑↓ select  Enter focus  d report",
      "k keep  r resume  a completed  q close",
      "",
    ];
    if (input !== null)
      lines.push("Resume request (Enter send / Esc cancel)", input);
    else if (detail && row) {
      const text = JSON.stringify(
        {
          task: row.task,
          role: row.label,
          status: row.status,
          report: row.report,
          sessionFile: row.sessionFile,
          evidenceDirectory: row.dir,
          context: row.usage,
        },
        null,
        2,
      )
        .split("\n")
        .flatMap((line) => wrap(line, width - 1));
      lines.push(...text.slice(offset, offset + height - 8));
    } else {
      const start = Math.max(0, selected - (height - 10));
      for (const [i, r] of rows.entries())
        if (i >= start && lines.length < height - 2)
          lines.push(
            `${i === selected ? ">" : " "} ${r.keep ? "* " : ""}[${r.status}] ${r.label}${r.usage?.warning ? " CONTEXT" : ""}`,
          );
      if (!rows.length) lines.push("No delegated work yet.");
    }
    lines.push(note);
    process.stdout.write(
      "\x1b[H\x1b[2J" +
        lines
          .slice(0, height - 1)
          .map((line) =>
            Array.from(clean(line))
              .slice(0, width - 1)
              .join(""),
          )
          .join("\r\n"),
    );
  }
  async function refresh() {
    if (busy || done) return;
    busy = true;
    try {
      snapshot = await boardSnapshot(scope);
      draw();
    } catch (e) {
      note = String(e);
      draw();
    } finally {
      busy = false;
    }
  }
  process.stdin.on("keypress", async (str, key = {}) => {
    try {
      if (key.ctrl && key.name === "c") return exit();
      const row = visible()[selected];
      if (input !== null) {
        if (key.name === "escape") input = null;
        else if (key.name === "return") {
          if (!input.trim() || !row?.bundle)
            throw Error("Select a task and describe the follow-up.");
          if (
            snapshot.parent?.status !== "active" ||
            liveness(snapshot.parent.instance) !== "alive"
          )
            throw Error(
              "Owner has ended. Resume in a new Orchestrator with saved task references; old agents are not adopted.",
            );
          await writeJSON(
            path.join(scope, "board-requests", randomUUID() + ".json"),
            {
              action: "resume",
              bundle: row.bundle,
              text: input,
              owner: snapshot.parent.instance.token,
            },
          );
          input = null;
          note = "Request sent to Orchestrator; no work was silently reopened.";
        } else if (key.name === "backspace")
          input = Array.from(input).slice(0, -1).join("");
        else if (str && !key.ctrl && !key.meta && input.length < 2000)
          input += str;
      } else if (key.name === "q") return exit();
      else if (key.name === "up") {
        if (detail) offset = Math.max(0, offset - 1);
        else selected--;
      } else if (key.name === "down") {
        if (detail) offset++;
        else selected++;
      } else if (key.name === "d") {
        detail = !detail;
        offset = 0;
      } else if (key.name === "a") showClosed = !showClosed;
      else if (key.name === "k" && row) {
        await writeJSON(path.join(row.dir, "keep.json"), {
          keep: !row.keep,
          reason: "board-user-choice",
        });
        await refresh();
      } else if (key.name === "r" && row?.bundle) input = "";
      else if (key.name === "return" && row) {
        if (row.status === "closed") detail = true;
        else if (row.live === "alive") await herdr(["agent", "focus", row.id]);
        else if (row.tab) await herdr(["tab", "focus", row.tab]);
      }
      draw();
    } catch (e) {
      note = String(e);
      draw();
    }
  });
  const timer = setInterval(refresh, 2000);
  process.on("SIGTERM", exit);
  process.stdout.on("resize", draw);
  await refresh();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runBoard(path.resolve(process.argv[2]));
