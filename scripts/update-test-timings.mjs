#!/usr/bin/env node
// Fold recorded unit timings (DEVRYAN_TEST_TIMINGS files, e.g. the CI
// `test-timings-<lane>` artifacts) into scripts/test-unit-timings.json, which
// scripts/test-ci-lanes.mjs packs lanes from. Passed units only; a recording
// replaces the stored value, averaged with it to damp one noisy run.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TIMINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-unit-timings.json');

export function mergeUnitTimings(stored, recordings) {
  const units = { ...stored };
  for (const recording of recordings) {
    if (recording?.schemaVersion !== 1 || !Array.isArray(recording.units)) throw new Error('Unsupported timing recording');
    for (const unit of recording.units) {
      if (unit.status !== 'passed' || !Number.isFinite(unit.ms)) continue;
      units[unit.name] = units[unit.name] === undefined ? unit.ms : Math.round((units[unit.name] + unit.ms) / 2);
    }
  }
  return Object.fromEntries(Object.entries(units).sort(([left], [right]) => left.localeCompare(right)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('Usage: bun run test:timings:update <timings.json...>');
  const document = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'));
  document.units = mergeUnitTimings(document.units, files.map((file) => JSON.parse(readFileSync(file, 'utf8'))));
  writeFileSync(TIMINGS_FILE, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Updated ${Object.keys(document.units).length} unit timings from ${files.length} recording(s).`);
}
