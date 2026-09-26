import * as fs from "node:fs";

/** The desktop app owns this preference; missing settings keep the on-by-default behavior. */
export class GoalContinuationPreference {
  private lastGood = true;
  private readonly settingsPath: string;
  constructor(settingsPath: string) { this.settingsPath = settingsPath; }

  enabled(): boolean {
    try {
      const settings: unknown = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      if (settings && typeof settings === "object") {
        const value = (settings as Record<string, unknown>).continue_interrupted_goals;
        this.lastGood = typeof value === "boolean" ? value : true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.lastGood = true;
      // A concurrent write can briefly expose incomplete JSON. Keep the last
      // valid preference until the next read rather than changing behavior.
    }
    return this.lastGood;
  }
}
