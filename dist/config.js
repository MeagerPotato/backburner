import { paths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { systemTimeZone, WEEKDAYS } from "./time.js";
import { PROVIDERS } from "./usage.js";
export const DEFAULT_CONFIG = {
    timezone: systemTimeZone(),
    reserves: { mon: 5, tue: 5, wed: 5, thu: 5, fri: 5, sat: 3, sun: 3 },
    weeklyCap: 95,
    releaseHour: 23,
    sweepHours: 12,
    presence: { idleMinutes: 30 },
    fiveHour: { maxWhileActive: 50, maxWhileAway: 90 },
    estimates: {
        small: { pct: 1, minutes: 10 },
        medium: { pct: 3, minutes: 30 },
        large: { pct: 8, minutes: 90 },
    },
    run: {
        claudePath: "claude",
        timeoutMinutes: 60,
        staleMinutes: 20,
        researchTools: ["WebSearch", "WebFetch", "Read", "Grep", "Glob"],
        codeTools: [
            "Read",
            "Edit",
            "Write",
            "Grep",
            "Glob",
            "WebSearch",
            "WebFetch",
            "Bash(npm test:*)",
            "Bash(npm run:*)",
        ],
        openDraftPr: true,
    },
    engines: ["claude"],
    codex: { path: "codex", search: true },
    guard: "warn",
    statusline: { showLine: true },
};
function isPlain(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function merge(base, over) {
    if (!isPlain(base) || !isPlain(over))
        return (over === undefined ? base : over);
    const out = { ...base };
    for (const [k, v] of Object.entries(over))
        out[k] = merge(base[k], v);
    return out;
}
export function validate(c) {
    const errors = [];
    const pct = (name, v) => {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)
            errors.push(`${name} must be a number from 0 to 100`);
    };
    for (const d of WEEKDAYS)
        pct(`reserves.${d}`, c.reserves[d]);
    pct("weeklyCap", c.weeklyCap);
    pct("fiveHour.maxWhileActive", c.fiveHour.maxWhileActive);
    pct("fiveHour.maxWhileAway", c.fiveHour.maxWhileAway);
    if (!Number.isInteger(c.releaseHour) || c.releaseHour < 0 || c.releaseHour > 24)
        errors.push("releaseHour must be a whole hour from 0 to 24");
    if (typeof c.sweepHours !== "number" || c.sweepHours < 0)
        errors.push("sweepHours must be 0 or more");
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
    }
    catch {
        errors.push(`timezone "${c.timezone}" is not a valid IANA time zone`);
    }
    if (!["off", "warn", "block"].includes(c.guard))
        errors.push('guard must be "off", "warn" or "block"');
    if (!Array.isArray(c.engines) || c.engines.length === 0 || c.engines.some((e) => !PROVIDERS.includes(e))) {
        errors.push(`engines must list one or more of: ${PROVIDERS.join(", ")}`);
    }
    const weekly = WEEKDAYS.reduce((s, d) => s + c.reserves[d], 0);
    if (weekly > c.weeklyCap)
        errors.push(`reserves add up to ${weekly}%, more than the ${c.weeklyCap}% cap, so the queue could never run`);
    return errors;
}
export function loadConfig() {
    return merge(DEFAULT_CONFIG, readJson(paths.config(), {}));
}
export function saveConfig(c) {
    writeJson(paths.config(), c);
}
/** Set a dotted key such as `reserves.mon` or `run.model`. Numbers and booleans are parsed. */
export function setConfigValue(c, key, raw) {
    const parts = key.split(".");
    const next = structuredClone(c);
    let node = next;
    for (const p of parts.slice(0, -1)) {
        if (!isPlain(node[p]))
            throw new Error(`Unknown config key: ${key}`);
        node = node[p];
    }
    const leaf = parts.at(-1);
    if (!(leaf in node) && !((parts[0] === "run" || parts[0] === "codex") && leaf === "model") && !(parts[0] === "statusline" && leaf === "chain")) {
        throw new Error(`Unknown config key: ${key}`);
    }
    const current = node[leaf];
    let value = raw;
    if (typeof current === "number")
        value = Number(raw);
    else if (typeof current === "boolean")
        value = raw === "true";
    else if (Array.isArray(current))
        value = raw.split(",").map((s) => s.trim()).filter(Boolean);
    node[leaf] = value;
    return next;
}
