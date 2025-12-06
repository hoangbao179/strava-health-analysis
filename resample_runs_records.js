// resample_runs_records.js
// Downsample runs_records.csv theo STEP_SECONDS

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

// ===== CONFIG =====
const ROOT_DIR = __dirname;
const INPUT_CSV = path.join(ROOT_DIR, "runs_records.csv");

// đổi số này tùy nhu cầu: 5, 10, 60...
const STEP_SECONDS = 10;

const OUTPUT_CSV = path.join(
  ROOT_DIR,
  `runs_records_${STEP_SECONDS}s.csv`
);

// ngưỡng dốc (%)
const UPHILL_THRESHOLD = 1.0;
const DOWNHILL_THRESHOLD = -1.0;

// ===== Helpers =====
function gradeCategory(grade) {
  if (typeof grade !== "number" || Number.isNaN(grade)) return "";
  if (grade >= UPHILL_THRESHOLD) return "uphill";
  if (grade <= DOWNHILL_THRESHOLD) return "downhill";
  return "flat";
}

function avgField(rows, field) {
  const vals = rows
    .map((r) => parseFloat(r[field]))
    .filter((v) => !Number.isNaN(v));
  if (!vals.length) return "";
  const sum = vals.reduce((a, b) => a + b, 0);
  return sum / vals.length;
}

function sumField(rows, field) {
  const vals = rows
    .map((r) => parseFloat(r[field]))
    .filter((v) => !Number.isNaN(v));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0);
}

function maxField(rows, field) {
  const vals = rows
    .map((r) => parseFloat(r[field]))
    .filter((v) => !Number.isNaN(v));
  if (!vals.length) return null;
  return Math.max(...vals);
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);

  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(",")),
  ];

  return lines.join("\n");
}

// ===== MAIN =====
function main() {
  if (!fs.existsSync(INPUT_CSV)) {
    console.error("Không tìm thấy runs_records.csv, chạy export trước đã.");
    process.exit(1);
  }

  const text = fs.readFileSync(INPUT_CSV, "utf8");
  const rows = parse(text, { columns: true, skip_empty_lines: true });

  console.log("Total raw rows:", rows.length);

  // group theo activity_id
  const byAct = new Map();
  for (const r of rows) {
    const id = r.activity_id;
    if (!byAct.has(id)) byAct.set(id, []);
    byAct.get(id).push(r);
  }

  const out = [];

  for (const [actId, actRows] of byAct.entries()) {
    actRows.sort(
      (a, b) =>
        parseFloat(a.elapsed_sec_from_start || 0) -
        parseFloat(b.elapsed_sec_from_start || 0)
    );

    // bucket theo STEP_SECONDS
    const buckets = new Map();

    for (const r of actRows) {
      const t = parseFloat(r.elapsed_sec_from_start || 0);
      const bucketIndex = Math.floor(t / STEP_SECONDS);
      if (!buckets.has(bucketIndex)) {
        buckets.set(bucketIndex, []);
      }
      buckets.get(bucketIndex).push(r);
    }

    const sortedBuckets = Array.from(buckets.entries()).sort(
      (a, b) => a[0] - b[0]
    );

    let prevCumDist = 0;
    let prevAlt = null;

    for (const [bucketIndex, bucketRows] of sortedBuckets) {
      const first = bucketRows[0];

      const elapsedStart = bucketIndex * STEP_SECONDS;
      const timestampStart = first.timestamp;

      const hrAvg = avgField(bucketRows, "heart_rate");
      const cadAvg = avgField(bucketRows, "cadence");
      const altAvg = avgField(bucketRows, "altitude");

      // cum_distance_m và delta_distance_m do script export đã tính sẵn
      let cumDist = maxField(bucketRows, "cum_distance_m");
      if (cumDist === null) {
        // fallback: dùng distance từ thiết bị nếu có
        cumDist = maxField(bucketRows, "distance");
      }
      if (cumDist === null) cumDist = prevCumDist;

      const deltaDist = sumField(bucketRows, "delta_distance_m");

      const deltaElev = sumField(bucketRows, "delta_elev_m");
      let grade = null;
      if (deltaDist > 0.5 && deltaElev !== 0) {
        grade = (deltaElev / deltaDist) * 100.0;
      }

      const rowOut = {
        activity_id: actId,
        bucket_start_sec: elapsedStart,
        step_seconds: STEP_SECONDS,
        timestamp_start: timestampStart,

        avg_heart_rate: hrAvg,
        avg_cadence: cadAvg,
        avg_altitude_m: altAvg,

        cum_distance_m: cumDist,
        delta_distance_m: deltaDist,
        delta_elev_m: deltaElev || "",
        grade_percent: grade || "",
        grade_category: gradeCategory(grade),
      };

      out.push(rowOut);

      prevCumDist = cumDist;
      if (altAvg !== "") prevAlt = altAvg;
    }
  }

  const csv = toCsv(out);
  fs.writeFileSync(OUTPUT_CSV, csv, "utf8");
  console.log(
    `Saved ${out.length} rows to ${OUTPUT_CSV} (step = ${STEP_SECONDS}s)`
  );
}

main();
