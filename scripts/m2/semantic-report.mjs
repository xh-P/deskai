import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACTIONS = new Set(["SPEAK", "WAIT", "SILENT", "STOP", "RESUME", "ACCUMULATE", "DROP"]);
const ROUTES = new Set(["local", "model"]);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptDir, "../../tests/voice/fixtures/m2-semantic-cases.json");

function usage() {
  return [
    "Usage: node scripts/m2/semantic-report.mjs [--observed <path>] [--format text|json]",
    "Without --observed, every case is reported as UNTESTED."
  ].join("\n");
}

function parseArgs(argv) {
  let observedPath = null;
  let format = "text";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--observed") {
      if (!argv[i + 1]) throw new Error("--observed requires a JSON file path");
      observedPath = resolve(process.cwd(), argv[++i]);
      continue;
    }
    if (arg === "--format") {
      const value = argv[++i];
      if (value !== "text" && value !== "json") throw new Error("--format must be text or json");
      format = value;
      continue;
    }
    throw new Error("Unknown argument: " + arg);
  }
  return { observedPath, format };
}

async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error("Cannot read " + path + ": " + error.message);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid JSON in " + path + ": " + error.message);
  }
}

function validateFixture(fixture) {
  if (!fixture || fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases)) {
    throw new Error("Fixture must have schemaVersion 1 and a cases array");
  }
  const seen = new Set();
  for (const item of fixture.cases) {
    if (!item || typeof item.id !== "string" || !item.id) throw new Error("Fixture contains a case without an id");
    if (seen.has(item.id)) throw new Error("Duplicate fixture id: " + item.id);
    seen.add(item.id);
    if (!item.expected || !ACTIONS.has(item.expected.action) || !ROUTES.has(item.expected.route)) {
      throw new Error("Invalid expected action/route for fixture id: " + item.id);
    }
    if (item.expected.routes !== undefined) {
      if (!Array.isArray(item.expected.routes) || item.expected.routes.length === 0 ||
          item.expected.routes.some(route => !ROUTES.has(route)) || !item.expected.routes.includes(item.expected.route)) {
        throw new Error("Invalid expected route allowlist for fixture id: " + item.id);
      }
    }
    if (typeof item.expected.hard !== "boolean" || typeof item.expected.notes !== "string") {
      throw new Error("Invalid expected hard/notes fields for fixture id: " + item.id);
    }
    if (!["zh", "ja", "en"].includes(item.language)) throw new Error("Invalid language for fixture id: " + item.id);
    if (!["voice", "text"].includes(item.source) || typeof item.input !== "string") {
      throw new Error("Invalid source/input for fixture id: " + item.id);
    }
    if (!item.context || typeof item.context.outputPlaying !== "boolean") {
      throw new Error("Context must define outputPlaying for fixture id: " + item.id);
    }
    if (item.expected.action === "ACCUMULATE" && item.context.inputStillSpeaking !== true) {
      throw new Error("ACCUMULATE requires context.inputStillSpeaking=true for fixture id: " + item.id);
    }
    if (item.context.pendingQuestion !== undefined && item.context.pendingQuestion !== null) {
      if (!["awaiting", "unplayed", "stale"].includes(item.context.pendingQuestion.status) || typeof item.context.pendingQuestion.text !== "string") {
        throw new Error("Invalid pendingQuestion for fixture id: " + item.id);
      }
    }
  }
  return seen;
}

function validateObserved(observed) {
  if (!observed || observed.schemaVersion !== 1 || !Array.isArray(observed.cases)) {
    throw new Error("Observed JSON must have schemaVersion 1 and a cases array");
  }
  if (typeof observed.observationSource !== "string" || !observed.observationSource.trim()) {
    throw new Error("Observed JSON must identify observationSource");
  }
  const byId = new Map();
  const duplicateIds = new Set();
  for (const item of observed.cases) {
    if (!item || typeof item.id !== "string" || !item.id) {
      throw new Error("Observed JSON contains a case without an id");
    }
    if (byId.has(item.id)) duplicateIds.add(item.id);
    else byId.set(item.id, item);
  }
  return { byId, duplicateIds };
}

function inspectEvidence(item, sample) {
  const evidence = sample.evidence;
  if (item.context?.acousticEvidence?.requiresAudioEvidence) {
    const acoustic = evidence?.acousticEvidence;
    if (!acoustic || typeof acoustic !== "object" || typeof acoustic.basis !== "string" || !acoustic.basis.trim()) {
      return { invalid: "acoustic case requires runtime evidence.acousticEvidence.basis" };
    }
    const expected = item.context.acousticEvidence;
    const keys = ["nearEndSpeech", "echoOnly", "playbackReferenceMatched", "vadClass"];
    const mismatches = keys.filter(key => Object.hasOwn(expected, key) && acoustic[key] !== expected[key]);
    if (mismatches.length) return { failures: ["acoustic evidence mismatch: " + mismatches.join(", ")] };
  }
  if (item.context?.permissionCheck === "unchanged") {
    const before = evidence?.permissionsBefore;
    const after = evidence?.permissionsAfter;
    const validList = value => Array.isArray(value) && value.every(capability => typeof capability === "string");
    if (!validList(before) || !validList(after)) {
      return { invalid: "permission case requires evidence.permissionsBefore and evidence.permissionsAfter string arrays" };
    }
    const normalize = list => [...list].sort();
    if (JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after))) {
      return { failures: ["application permissions changed during the case"] };
    }
  }
  return { failures: [] };
}

function buildReport(fixture, observed) {
  const fixtureIds = validateFixture(fixture);
  const observedIndex = observed ? validateObserved(observed) : { byId: new Map(), duplicateIds: new Set() };
  const rows = fixture.cases.map(item => {
    if (observedIndex.duplicateIds.has(item.id)) {
      return { id: item.id, language: item.language, status: "INVALID", expected: item.expected, actual: null, detail: "duplicate observed id" };
    }
    const sample = observedIndex.byId.get(item.id);
    if (!sample) {
      return { id: item.id, language: item.language, status: "UNTESTED", expected: item.expected, actual: null, detail: "no observed result" };
    }
    const actual = sample.actual;
    if (!actual || !ACTIONS.has(actual.action) || !ROUTES.has(actual.route)) {
      return { id: item.id, language: item.language, status: "INVALID", expected: item.expected, actual: actual ?? null, detail: "actual must contain a valid action and route" };
    }
    const evidenceCheck = inspectEvidence(item, sample);
    if (evidenceCheck.invalid) {
      return { id: item.id, language: item.language, status: "INVALID", expected: item.expected, actual: { action: actual.action, route: actual.route }, evidence: sample.evidence ?? null, detail: evidenceCheck.invalid };
    }
    const allowedRoutes = item.expected.routes ?? [item.expected.route];
    const actionMatched = actual.action === item.expected.action && allowedRoutes.includes(actual.route);
    const matched = actionMatched && evidenceCheck.failures.length === 0;
    return {
      id: item.id,
      language: item.language,
      status: matched ? "PASS" : "FAIL",
      expected: item.expected,
      actual: { action: actual.action, route: actual.route },
      evidence: sample.evidence ?? null,
      detail: evidenceCheck.failures.join("; ") || (actionMatched ? "" : "action/route mismatch")
    };
  });
  const unexpected = observed
    ? [...observedIndex.byId.keys()].filter(id => !fixtureIds.has(id)).map(id => ({ id, status: "UNEXPECTED" }))
    : [];
  const counts = Object.fromEntries(["PASS", "FAIL", "UNTESTED", "INVALID"].map(status => [
    status, rows.filter(row => row.status === status).length
  ]));
  counts.UNEXPECTED = unexpected.length;
  return {
    schemaVersion: 1,
    suite: fixture.suite,
    observationSource: observed?.observationSource ?? null,
    counts,
    cases: rows,
    unexpected
  };
}

function renderText(report) {
  const source = report.observationSource ?? "none";
  const counts = Object.entries(report.counts).map(([key, value]) => key + "=" + value).join(" ");
  const lines = ["M2 semantic report | source=" + source, counts];
  for (const row of report.cases) {
    const expectedRoutes = row.expected.routes ?? [row.expected.route];
    const expected = row.expected.action + "/" + expectedRoutes.join("|");
    const actual = row.actual ? row.actual.action + "/" + row.actual.route : "—";
    lines.push(row.status + " " + row.id + " expected=" + expected + " actual=" + actual);
  }
  for (const row of report.unexpected) lines.push(row.status + " " + row.id);
  return lines.join("\n");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }
  const fixture = await readJson(fixturePath);
  const observed = args.observedPath ? await readJson(args.observedPath) : null;
  const report = buildReport(fixture, observed);
  process.stdout.write((args.format === "json" ? JSON.stringify(report, null, 2) : renderText(report)) + "\n");
  if (report.counts.FAIL || report.counts.INVALID || report.counts.UNEXPECTED) process.exitCode = 1;
} catch (error) {
  process.stderr.write(error.message + "\n" + usage() + "\n");
  process.exitCode = 2;
}

