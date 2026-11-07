import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How the controller session is started for a deck: the model and the effort. Kept beside the deck like the comments
 * and the audit log, so it is never part of the deck: it does not change the revision and an export leaves it out.
 */
export const CONTROLLER_FILE = "controller.json";
export const CONTROLLER_FORMAT = "depthcue-controller/1";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ControllerSettings {
  /** An alias such as `opus`, or a full model name. Empty means whatever Claude Code uses by default. */
  model?: string;
  effort?: Effort;
}

/**
 * What a model may be called. It ends up as one argument of a command, so it is limited to the characters that model
 * names and aliases use, and cannot start with a dash.
 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

export type SettingsCheck = { ok: true; settings: ControllerSettings } | { ok: false; message: string };

/** The settings in a value, or why they are not settings. Unknown keys are ignored; an empty value is left unset. */
export function checkSettings(value: unknown): SettingsCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "The settings must be an object." };
  }
  const { model, effort } = value as Record<string, unknown>;
  const settings: ControllerSettings = {};
  if (model !== undefined && model !== null && model !== "") {
    if (typeof model !== "string" || !MODEL_PATTERN.test(model.trim())) {
      return {
        ok: false,
        message:
          "The model is a name such as opus, sonnet or claude-opus-5-5: letters, digits and . _ : - only.",
      };
    }
    settings.model = model.trim();
  }
  if (effort !== undefined && effort !== null && effort !== "") {
    if (typeof effort !== "string" || !(EFFORTS as readonly string[]).includes(effort)) {
      return { ok: false, message: `The effort is one of ${EFFORTS.join(", ")}.` };
    }
    settings.effort = effort as Effort;
  }
  return { ok: true, settings };
}

export interface ReadSettings {
  settings: ControllerSettings;
  /** Set when the file is there but is not settings; the settings are then empty. */
  problem?: string;
}

/** The deck's controller settings. A missing file is no settings; a file that cannot be read is said, never thrown. */
export function readController(folder: string): ReadSettings {
  const path = join(folder, CONTROLLER_FILE);
  if (!existsSync(path)) return { settings: {} };
  try {
    const checked = checkSettings(JSON.parse(readFileSync(path, "utf8")));
    return checked.ok ? { settings: checked.settings } : { settings: {}, problem: checked.message };
  } catch {
    return { settings: {}, problem: `${CONTROLLER_FILE} is not valid JSON.` };
  }
}

/** Writes the settings whole, through a temporary file so a reader never sees half of it. */
export function writeController(folder: string, settings: ControllerSettings): void {
  const path = join(folder, CONTROLLER_FILE);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ format: CONTROLLER_FORMAT, ...settings }, null, 2)}\n`);
  renameSync(temporary, path);
}
