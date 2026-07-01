// build-mapping.mjs — reads raw PFS batches and matches motorway service
// forecourts to your existing service-stations.json entries.
//
// Produces station-mapping.draft.json for you to review.
// After manual review, rename to station-mapping.json.
//
// Run: npm run build-mapping

import fs from 'node:fs/promises';
import path from 'node:path';

const RAW_DIR = './raw';
const STATIONS_FILE = './service-stations.json';
const OUTPUT_FILE = './station-mapping.draft.json';
const REPORT_FILE = './mapping-report.txt';

// Max distance in km to consider a Fuel Finder forecourt a match for one of
// your service stations. Motorway services can span a large area (with north
// and south forecourts sometimes 1-2 km apart), so this needs to be generous.
const MATCH_RADIUS_KM = 3.0;

// Haversine distance between two lat/lng points, in km.
function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Guess direction from name + address text. Returns "Northbound", "Southbound",
// "Eastbound", "Westbound", or null.
function parseDirection(forecourt) {
    const text = [
        forecourt.trading_name || '',
        forecourt.location?.address_line_1 || '',
        forecourt.location?.address_line_2 || '',
    ].join(' ').toUpperCase();

    // Look for "NORTHBOUND", " NORTH ", "NB", etc. Order matters: check "SOUTHBOUND"
    // before "SOUTH" so it matches the longer form first.
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
    console.log('📂 Loading raw PFS data...');
    const forecourts = await loadAllForecourts();
    console.log(`   ${forecourts.length} total forecourts`);

    const motorwayForecourts = forecourts.filter(f => f.is_motorway_service_station);
    console.log(`   ${motorwayForecourts.length} motorway service forecourts`);

    console.log('📂 Loading service stations...');
    const stations = JSON.parse(await fs.readFile(STATIONS_FILE, 'utf-8'));
    console.log(`   ${stations.length} service stations in app`);

    console.log('🎯 Matching forecourts to service stations...');
    console.log('');

    const mapping = { stations: {} };
    const report = [];
    const unmatchedForecourts = new Set(motorwayForecourts.map(f => f.node_id));
    let matchedCount = 0;
    let ambiguousCount = 0;
    let noMatchCount = 0;

    for (const station of stations) {
        const candidates = motorwayForecourts
            .map(f => ({
                forecourt: f,
                distanceKm: haversineKm(
                    station.latitude, station.longitude,
                    f.location.latitude, f.location.longitude
                ),
            }))
            .filter(c => c.distanceKm <= MATCH_RADIUS_KM)
            .sort((a, b) => a.distanceKm - b.distanceKm);

        const entry = {
            name: station.name,
            fuel_finder: candidates.map(c => ({
                node_id: c.forecourt.node_id,
                trading_name: c.forecourt.trading_name,
                brand: c.forecourt.brand_name,
                postcode: c.forecourt.location.postcode,
                distance_km: Number(c.distanceKm.toFixed(2)),
                direction: parseDirection(c.forecourt),
            })),
        };

        mapping.stations[station.id] = entry;

        if (candidates.length === 0) {
            report.push(`⚠️  NO MATCH: ${station.name} (${station.postcode})`);
            noMatchCount++;
        } else if (candidates.length === 1) {
            report.push(`✓ ${station.name}: ${candidates[0].forecourt.trading_name} (${candidates[0].distanceKm.toFixed(2)}km)`);
            matchedCount++;
            unmatchedForecourts.delete(candidates[0].forecourt.node_id);
        } else {
            const details = candidates.map(c =>
                `      - ${c.forecourt.trading_name} [${c.forecourt.brand_name}] ${c.distanceKm.toFixed(2)}km ${parseDirection(c.forecourt) || '(no direction)'}`
            ).join('\n');
            report.push(`? MULTIPLE: ${station.name}\n${details}`);
            ambiguousCount++;
            for (const c of candidates) {
                unmatchedForecourts.delete(c.forecourt.node_id);
            }
        }
    }

    // List motorway forecourts we couldn't match to any station
    if (unmatchedForecourts.size > 0) {
        report.push('');
        report.push('--- Fuel Finder motorway services with NO matching station in your data:');
        for (const nodeId of unmatchedForecourts) {
            const fc = motorwayForecourts.find(f => f.node_id === nodeId);
            report.push(`   - ${fc.trading_name} [${fc.brand_name}] ${fc.location.postcode} (${fc.location.city})`);
        }
    }

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(mapping, null, 2));
    await fs.writeFile(REPORT_FILE, report.join('\n'));

    console.log(report.join('\n'));
    console.log('');
    console.log(`✅ Mapping written to ${OUTPUT_FILE}`);
    console.log(`   Report written to ${REPORT_FILE}`);
    console.log('');
    console.log(`Summary:`);
    console.log(`   ✓ Clean single matches:     ${matchedCount}`);
    console.log(`   ? Multiple candidates:      ${ambiguousCount}`);
    console.log(`   ⚠️  No match found:          ${noMatchCount}`);
    console.log(`   Fuel Finder stations unused: ${unmatchedForecourts.size}`);
    console.log('');
    console.log('Next: review the draft mapping, correct any issues, then rename');
    console.log(`      ${OUTPUT_FILE} → station-mapping.json`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});