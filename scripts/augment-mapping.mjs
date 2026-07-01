// augment-mapping.mjs — fills gaps in station-mapping.draft.json by
// searching all raw forecourts (motorway or not) for postcode matches.
//
// Useful for stations where the initial coordinate-based matching missed
// entries because:
//   - The retailer didn't flag themselves as is_motorway_service_station
//   - Their coordinates differ from your app's data by more than 3km
//
// Run: npm run augment-mapping
//
// Reads:  station-mapping.draft.json + raw/*.json + service-stations.json
// Writes: station-mapping.augmented.json + augment-report.txt

import fs from 'node:fs/promises';
import path from 'node:path';

const RAW_DIR = './raw';
const STATIONS_FILE = './service-stations.json';
const DRAFT_MAPPING_FILE = './station-mapping.draft.json';
const OUTPUT_FILE = './station-mapping.augmented.json';
const REPORT_FILE = './augment-report.txt';

// Normalise postcodes for comparison: uppercase, strip all whitespace.
// So "SG7 5TR" and "sg75tr" both become "SG75TR".
function normalisePostcode(pc) {
    return (pc || '').toUpperCase().replace(/\s+/g, '');
}

// Guess direction from name + address text.
function parseDirection(forecourt) {
    const text = [
        forecourt.trading_name || '',
        forecourt.location?.address_line_1 || '',
        forecourt.location?.address_line_2 || '',
    ].join(' ').toUpperCase();

    if (/\bNORTHBOUND\b|\bNORTH\b|\b NB\b/.test(text)) return 'Northbound';
    if (/\bSOUTHBOUND\b|\bSOUTH\b|\b SB\b/.test(text)) return 'Southbound';
    if (/\bEASTBOUND\b|\bEAST\b|\b EB\b/.test(text)) return 'Eastbound';
    if (/\bWESTBOUND\b|\bWEST\b|\b WB\b/.test(text)) return 'Westbound';
    return null;
}

async function loadAllForecourts() {
    const files = await fs.readdir(RAW_DIR);
    const batchFiles = files.filter(f => f.startsWith('pfs-batch-') && f.endsWith('.json'));

    if (batchFiles.length === 0) {
        throw new Error(`No batch files in ${RAW_DIR}. Run 'npm run fetch-pfs' first.`);
    }

    const all = [];
    for (const file of batchFiles) {
        const content = await fs.readFile(path.join(RAW_DIR, file), 'utf-8');
        all.push(...JSON.parse(content));
    }
    return all;
}

async function main() {
    console.log('📂 Loading data...');
    const stations = JSON.parse(await fs.readFile(STATIONS_FILE, 'utf-8'));
    const draftMapping = JSON.parse(await fs.readFile(DRAFT_MAPPING_FILE, 'utf-8'));
    const forecourts = await loadAllForecourts();
    console.log(`   ${stations.length} stations, ${forecourts.length} forecourts, ${Object.keys(draftMapping.stations).length} draft entries`);
    console.log('');

    // Build a postcode → forecourts index for fast lookup.
    const postcodeIndex = new Map();
    for (const fc of forecourts) {
        const pc = normalisePostcode(fc.location?.postcode);
        if (!pc) continue;
        if (!postcodeIndex.has(pc)) postcodeIndex.set(pc, []);
        postcodeIndex.get(pc).push(fc);
    }

    console.log('🔍 Searching for postcode matches...');
    console.log('');

    const augmented = { stations: {} };
    const report = [];
    let addedCount = 0;
    let newMatchCount = 0;

    for (const station of stations) {
        const existing = draftMapping.stations[station.id] || {
            name: station.name,
            fuel_finder: [],
        };

        // Existing node_ids so we don't add duplicates
        const existingNodeIds = new Set(existing.fuel_finder.map(f => f.node_id));

        const stationPostcode = normalisePostcode(station.postcode);
        const postcodeMatches = postcodeIndex.get(stationPostcode) || [];

        // Find new matches (postcode matches not already in existing)
        const newMatches = postcodeMatches
            .filter(fc => !existingNodeIds.has(fc.node_id))
            .map(fc => ({
                node_id: fc.node_id,
                trading_name: fc.trading_name,
                brand: fc.brand_name,
                postcode: fc.location.postcode,
                is_motorway_service_station: fc.is_motorway_service_station,
                direction: parseDirection(fc),
                matched_by: 'postcode',
            }));

        if (newMatches.length > 0) {
            addedCount += newMatches.length;
            if (existing.fuel_finder.length === 0) newMatchCount++;

            const flag = existing.fuel_finder.length === 0 ? '🆕 FILLED GAP' : '➕ ADDED';
            report.push(`${flag}: ${station.name} (${station.postcode})`);
            for (const m of newMatches) {
                const motorwayNote = m.is_motorway_service_station ? '' : ' (NOT flagged as motorway)';
                report.push(`      + ${m.trading_name} [${m.brand}] ${m.direction || '(no direction)'}${motorwayNote}`);
            }
        }

        augmented.stations[station.id] = {
            name: station.name,
            fuel_finder: [...existing.fuel_finder, ...newMatches],
        };
    }

    // Also report stations still with no matches at all
    const stillNoMatch = stations.filter(s =>
        augmented.stations[s.id].fuel_finder.length === 0
    );

    if (stillNoMatch.length > 0) {
        report.push('');
        report.push('--- Stations STILL with no fuel data:');
        for (const s of stillNoMatch) {
            report.push(`   ⚠️  ${s.name} (${s.postcode})`);
        }
    }

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(augmented, null, 2));
    await fs.writeFile(REPORT_FILE, report.join('\n'));

    console.log(report.join('\n'));
    console.log('');
    console.log(`✅ Augmented mapping written to ${OUTPUT_FILE}`);
    console.log(`   Report written to ${REPORT_FILE}`);
    console.log('');
    console.log(`Summary:`);
    console.log(`   ➕ Total new forecourts added: ${addedCount}`);
    console.log(`   🆕 Previously-empty stations now filled: ${newMatchCount}`);
    console.log(`   ⚠️  Stations still with no match: ${stillNoMatch.length}`);
    console.log('');
    console.log('Next: review the augmented mapping, then rename');
    console.log(`      ${OUTPUT_FILE} → station-mapping.json`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});