import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.js";
export function readJson(file, fallback) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return fallback;
    }
}
/** Write via a temp file and rename, so a crash never leaves half a file behind. */
export function writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, file);
}
export function log(message) {
    try {
        mkdirSync(dirname(paths.log()), { recursive: true });
        appendFileSync(paths.log(), `${new Date().toISOString()} ${message}\n`);
    }
    catch {
        // Logging must never break a run.
    }
}
