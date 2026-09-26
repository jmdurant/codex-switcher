import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalContinuationPreference } from "../src/goalPreference.ts";

test("desktop setting controls continuation with an enabled default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-preference-"));
  try {
    const file = path.join(root, "settings.json");
    const preference = new GoalContinuationPreference(file);
    assert.equal(preference.enabled(), true);
    fs.writeFileSync(file, JSON.stringify({continue_interrupted_goals:false}));
    assert.equal(preference.enabled(), false);
    fs.writeFileSync(file, "{");
    assert.equal(preference.enabled(), false, "incomplete write retains last valid value");
    fs.writeFileSync(file, JSON.stringify({continue_interrupted_goals:true}));
    assert.equal(preference.enabled(), true);
    fs.unlinkSync(file);
    assert.equal(preference.enabled(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
