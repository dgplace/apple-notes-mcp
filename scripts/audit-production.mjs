import { spawnSync } from "node:child_process";

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});

if (audit.error || audit.signal || !audit.stdout) {
  const reason = audit.error?.message ?? (audit.signal ? `terminated by ${audit.signal}` : "returned no JSON report");
  console.error(`Production dependency audit could not run: ${reason}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("Production dependency audit returned invalid JSON.");
  process.exit(2);
}

const counts = report.metadata?.vulnerabilities;
if (!counts || typeof counts.high !== "number" || typeof counts.critical !== "number") {
  console.error("Production dependency audit did not include vulnerability counts.");
  process.exit(2);
}

const summary = ["critical", "high", "moderate", "low", "info"]
  .map((severity) => `${severity}=${counts[severity] ?? 0}`)
  .join(" ");
console.log(`Production dependency audit: ${summary}`);

const findings = Object.entries(report.vulnerabilities ?? {})
  .filter(([, value]) => value && typeof value === "object")
  .map(([name, value]) => `${name} (${value.severity ?? "unknown"})`)
  .sort();
if (findings.length > 0) {
  console.log(`Reported packages: ${findings.join(", ")}`);
}

if (counts.critical > 0 || counts.high > 0) {
  console.error("High or critical production dependency vulnerabilities require reachability triage before release.");
  process.exit(1);
}

if ((counts.moderate ?? 0) > 0 || (counts.low ?? 0) > 0) {
  console.log(
    "No high/critical finding. Accepted lower-severity findings must remain documented in DEPENDENCY_AUDIT.md.",
  );
}

// npm audit exits nonzero for any reported vulnerability. The release gate is
// deliberately based on parsed high/critical counts, so the reviewed,
// unreachable moderate advisory does not make CI permanently red.
process.exit(0);
