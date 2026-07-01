// refine-mapping.mjs — reads station-mapping.augmented.json and prunes
// candidates that don't match the known fuel brand for each station.
//
// Uses service-stations.json's `fuel.brands` field to filter candidates.
// If a station has brand info and any candidate matches, only matched
// candidates are kept. If no candidates match (or no brand info exists),
// all candidates are preserved.
//
// Run: npm run refine-mapping
//
// Reads:  station-mapping.augmented.json + service-stations.json
// Writes: station-mapping.refined.json + refine-report.txt

import fs from 'node:fs/promises';

const STATIONS_FILE = './service-stations.json';
const INPUT_FILE = './station-mapping.augmented.json';
const OUTPUT_FILE = './station-mapping.refined.json';
const REPORT_FILE = './refine-report.txt';

// Normalise brand names for comparison: uppercase, strip whitespace.
// "Welcome Break" and "WELCOME BREAK" and "welcomebreak" all become "WELCOMEBREAK".
function normaliseBrand(b) {
    return (b || '').toUpperCase().replace(/\s+/g, '');
}

async function main() {
    console.log('📂 Loading data...');
    const stations = JSON.parse(await fs.readFile(STATIONS_FILE, 'utf-8'));
    const mapping = JSON.parse(await fs.readFile(INPUT_FILE, 'utf-8'));
    console.log(`   ${stations.length} stations, ${Object.keys(mapping.stations).length} mapping entries`);
    console.log('');

    // Build a lookup from station id → known fuel brands (uppercase, no spaces).
    const knownBrands = new Map();
    for (const station of stations) {
        const brands = station.details?.fuel?.brands || [];
        if (brands.length > 0) {
            knownBrands.set(station.id, new Set(brands.map(normaliseBrand)));
        }
    }

    console.log('🔍 Pruning candidates by fuel brand...');
    console.log('');

    const refined = { stations: {} };
    const report = [];
    let prunedTotal = 0;
    let stationsRefined = 0;
    let stationsSkipped = 0;

    for (const [stationId, entry] of Object.entries(mapping.stations)) {
        const known = knownBrands.get(stationId);

        // No known brand info → keep everything as-is.
        // Only report the skip if there are multiple candidates (single/zero is trivial).
        if (!known || known.size === 0) {
            refined.stations[stationId] = entry;
            if (entry.fuel_finder.length > 1) {
                report.push(`⏭️  SKIP (no brand info): ${entry.name} — ${entry.fuel_finder.length} candidates kept`);
                stationsSkipped++;
            }
            continue;
        }

        // Match each candidate's brand against the known brands
        const matched = entry.fuel_finder.filter(fc => known.has(normaliseBrand(fc.brand)));
        const unmatched = entry.fuel_finder.filter(fc => !known.has(normaliseBrand(fc.brand)));

        if (matched.length === 0) {
            // No brand match found — keep all candidates, but flag it
            refined.stations[stationId] = entry;
            if (entry.fuel_finder.length > 0) {
                const knownList = [...known].join(', ');
                const candidateBrands = entry.fuel_finder.map(fc => fc.brand).join(', ');
                report.push(`⚠️  NO BRAND MATCH: ${entry.name}`);
                report.push(`      Known brands: ${knownList}`);
                report.push(`      Candidate brands: ${candidateBrands}`);
                report.push(`      → Keeping all ${entry.fuel_finder.length} candidates for manual review`);
            }
        } else if (unmatched.length === 0) {
            // Everything matches — no change needed
            refined.stations[stationId] = entry;
        } else {
            // Some matches, some don't — keep only matches
            refined.stations[stationId] = {
                ...entry,
                fuel_finder: matched,
            };
            const prunedNames = unmatched.map(fc => `${fc.trading_name} [${fc.brand}]`);
            report.push(`✂️  PRUNED: ${entry.name} — kept ${matched.length}, removed ${unmatched.length}`);
            for (const name of prunedNames) {
                report.push(`      − ${name}`);
            }
            prunedTotal += unmatched.length;
            stationsRefined++;
        }
    }

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(refined, null, 2));
    await fs.writeFile(REPORT_FILE, report.join('\n'));

    console.log(report.join('\n'));
    console.log('');
    console.log(`✅ Refined mapping written to ${OUTPUT_FILE}`);
    console.log(`   Report written to ${REPORT_FILE}`);
    console.log('');
    console.log(`Summary:`);
    console.log(`   ✂️  Candidates pruned:  ${prunedTotal}`);
    console.log(`   Stations refined:       ${stationsRefined}`);
    console.log(`   Stations skipped (no brand info): ${stationsSkipped}`);
    console.log('');
    console.log('Next: review the refined mapping, then rename');
    console.log(`      ${OUTPUT_FILE} → station-mapping.json`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});