// export_runs_records.js
// Node >= 16, dùng ESM syntax

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { parse as parseCsv } from "csv-parse/sync";
import FitParser from "fit-file-parser";
import { parseStringPromise } from "xml2js";
import { fileURLToPath } from "url";

// ===== CONFIG (đường dẫn tương đối) =====
const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.dirname(__filename);

const ACTIVITIES_CSV = path.join(ROOT_DIR, "activities.csv");
const ACTIVITIES_DIR = path.join(ROOT_DIR, "activities");
const OUTPUT_CSV = path.join(ROOT_DIR, "runs_records.csv");

// Giới hạn số buổi chạy (Infinity = tất cả)
const MAX_RUNS = Infinity;

// Ngưỡng phân loại dốc (%)
const UPHILL_THRESHOLD = 1.0;
const DOWNHILL_THRESHOLD = -1.0;

// ===== Helper: CSV =====
function toCsv(rows) {
  if (!rows || !rows.length) return "";

  const headerSet = new Set();
  for (const row of rows) {
    Object.keys(row).forEach((k) => headerSet.add(k));
  }
  const headers = Array.from(headerSet);

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

// ===== Helpers: đọc cột trong activities.csv =====
function getActivityType(row) {
  const t =
    row.type ??
    row["Activity Type"] ??
    row["activity_type"] ??
    "";
  return String(t).trim();
}

function getActivityId(row) {
  return String(
    row.id ??
      row["Activity ID"] ??
      row["activity_id"] ??
      ""
  ).trim();
}

function getFilenamePath(row) {
  // cột Filename: "activities/9739913106.fit.gz"
  const f =
    row.Filename ??
    row["Filename"] ??
    row["filename"] ??
    "";
  if (!f) return null;

  // bỏ ./ hoặc / đầu, đổi / -> path.sep cho Windows
  const normalized = String(f)
    .trim()
    .replace(/^\.?[\\/]/, "")
    .replace(/\//g, path.sep);

  return path.join(ROOT_DIR, normalized);
}

// fallback nếu không có Filename (trường hợp khác)
function findActivityFileById(activityId) {
  const exts = [".fit.gz", ".gpx.gz", ".tcx.gz", ".fit", ".gpx", ".tcx"];
  for (const ext of exts) {
    const p = path.join(ACTIVITIES_DIR, `${activityId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function gradeCategory(grade) {
  if (typeof grade !== "number" || Number.isNaN(grade)) return "";
  if (grade >= UPHILL_THRESHOLD) return "uphill";
  if (grade <= DOWNHILL_THRESHOLD) return "downhill";
  return "flat";
}

// ===== FIT parsing =====
async function parseFitFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const raw = filePath.endsWith(".gz")
    ? zlib.gunzipSync(buffer)
    : buffer;

  const fitParser = new FitParser({
    force: true,
    speedUnit: "m/s",
    lengthUnit: "m",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
  });

  const data = await fitParser.parseAsync(raw);
  const records = data.records || [];

  return records
    .filter((r) => r.timestamp)
    .map((r) => ({
      ...r,
      timestamp: new Date(r.timestamp),
    }));
}

// ===== GPX parsing =====
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function parseGpxFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const xml = filePath.endsWith(".gz")
    ? zlib.gunzipSync(buffer).toString("utf8")
    : buffer.toString("utf8");

  const res = await parseStringPromise(xml);

  const trk =
    res.gpx && res.gpx.trk && res.gpx.trk[0]
      ? res.gpx.trk[0]
      : null;
  if (!trk || !trk.trkseg || !trk.trkseg[0].trkpt) return [];

  const pts = trk.trkseg[0].trkpt;
  const records = [];

  let prevLat = null;
  let prevLon = null;
  let cumDist = 0;

  for (const pt of pts) {
    const lat = parseFloat(pt.$.lat);
    const lon = parseFloat(pt.$.lon);
    const timeStr = pt.time && pt.time[0];
    if (!timeStr) continue;

    const altitude = pt.ele ? parseFloat(pt.ele[0]) : null;

    if (prevLat !== null) {
      cumDist += haversine(prevLat, prevLon, lat, lon);
    }
    prevLat = lat;
    prevLon = lon;

    let heartRate = null;
    let cadence = null;
    if (
      pt.extensions &&
      pt.extensions[0] &&
      pt.extensions[0]["gpxtpx:TrackPointExtension"]
    ) {
      const ext = pt.extensions[0]["gpxtpx:TrackPointExtension"][0];
      if (ext["gpxtpx:hr"]) {
        heartRate = Number(ext["gpxtpx:hr"][0]);
      }
      if (ext["gpxtpx:cad"]) {
        cadence = Number(ext["gpxtpx:cad"][0]);
      }
    }

    const ts = new Date(timeStr);

    records.push({
      timestamp: ts,
      latitude: lat,
      longitude: lon,
      altitude,
      distance: cumDist,
      heart_rate: heartRate,
      cadence,
    });
  }

  return records;
}

// ===== tăng cường record cho 1 activity =====
function enhanceRecordsForActivity(records, activityId) {
  const valid = records
    .filter(
      (r) =>
        r.timestamp instanceof Date &&
        !Number.isNaN(r.timestamp.valueOf())
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!valid.length) return [];

  const t0 = valid[0].timestamp.getTime();
  let prevDist = 0;
  let prevAlt = null;

  const out = [];

  for (const rec of valid) {
    const t = rec.timestamp.getTime();
    const elapsedSec = (t - t0) / 1000;

    const hasDist =
      typeof rec.distance === "number" &&
      !Number.isNaN(rec.distance);
    const cumDist = hasDist ? rec.distance : prevDist;
    let deltaDist = cumDist - prevDist;
    if (deltaDist < 0) deltaDist = 0;

    const hasAlt =
      typeof rec.altitude === "number" &&
      !Number.isNaN(rec.altitude);
    const alt = hasAlt
      ? rec.altitude
      : prevAlt !== null
      ? prevAlt
      : null;

    let deltaElev = null;
    let grade = null;
    if (
      alt !== null &&
      prevAlt !== null &&
      deltaDist > 0.5
    ) {
      deltaElev = alt - prevAlt;
      grade = (deltaElev / deltaDist) * 100.0;
    }

    const row = {
      activity_id: activityId,
      elapsed_sec_from_start: elapsedSec,
      ...rec,
      cum_distance_m: cumDist,
      delta_distance_m: deltaDist,
      delta_elev_m: deltaElev,
      grade_percent: grade,
      grade_category: gradeCategory(grade),
    };

    out.push(row);

    prevDist = cumDist;
    if (alt !== null) prevAlt = alt;
  }

  return out;
}

// ===== MAIN =====
async function main() {
  const csvBuffer = fs.readFileSync(ACTIVITIES_CSV);
  const activities = parseCsv(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
  });

  const runs = activities.filter(
    (a) => getActivityType(a) === "Run"
  );
  console.log(`Total runs in activities.csv: ${runs.length}`);

  const slice = runs.slice(0, Math.min(runs.length, MAX_RUNS));
  const allRows = [];

  for (let i = 0; i < slice.length; i++) {
    const a = slice[i];
    const id = getActivityId(a);

    // ƯU TIÊN dùng cột Filename
    let filePath = getFilenamePath(a);
    if (!filePath || !fs.existsSync(filePath)) {
      filePath = findActivityFileById(id); // fallback
    }

    console.log(
      `[${i + 1}/${slice.length}] activity ${id} -> ${
        filePath ? path.relative(ROOT_DIR, filePath) : "NO FILE"
      }`
    );

    if (!filePath) continue;

    let records = [];
    try {
      if (filePath.endsWith(".fit") || filePath.endsWith(".fit.gz")) {
        records = await parseFitFile(filePath);
      } else if (filePath.endsWith(".gpx") || filePath.endsWith(".gpx.gz")) {
        records = await parseGpxFile(filePath);
      } else {
        console.log("  Unsupported file type, skip");
        continue;
      }
    } catch (err) {
      console.error("  Error parsing file:", err.message);
      continue;
    }

    if (!records.length) {
      console.log("  No records parsed");
      continue;
    }

    const enhanced = enhanceRecordsForActivity(records, id);
    console.log(`  -> ${enhanced.length} records`);
    allRows.push(...enhanced);
  }

  if (!allRows.length) {
    console.log("No records exported.");
    return;
  }

  const csv = toCsv(allRows);
  fs.writeFileSync(OUTPUT_CSV, csv, "utf8");
  console.log(`Saved ${allRows.length} rows to ${OUTPUT_CSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
