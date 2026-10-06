import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piSubmitKeyOverride } from "../pi-extension/subagents/herdr.ts";

function dirWith(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-"));
  if (content !== undefined) writeFileSync(join(dir, "keybindings.json"), content);
  return dir;
}

test("no override when file missing, invalid, or submit unset", () => {
  assert.equal(piSubmitKeyOverride(dirWith()), undefined);
  assert.equal(piSubmitKeyOverride(dirWith("{nope")), undefined);
  assert.equal(piSubmitKeyOverride(dirWith("null")), undefined);
  assert.equal(piSubmitKeyOverride(dirWith("{}")), undefined);
  assert.equal(piSubmitKeyOverride(dirWith('{"tui.input.submit": []}')), undefined);
});

test("no override when enter is among submit keys", () => {
  assert.equal(piSubmitKeyOverride(dirWith('{"tui.input.submit": "Enter"}')), undefined);
  assert.equal(piSubmitKeyOverride(dirWith('{"tui.input.submit": ["alt+enter","enter"]}')), undefined);
});

test("returns first key when enter not bound", () => {
  assert.equal(piSubmitKeyOverride(dirWith('{"tui.input.submit": "alt+enter"}')), "alt+enter");
  assert.equal(piSubmitKeyOverride(dirWith('{"tui.input.submit": ["ctrl+j","alt+enter"]}')), "ctrl+j");
  assert.equal(piSubmitKeyOverride(dirWith('{"tui.input.submit": [1, "alt+enter"]}')), "alt+enter");
});
