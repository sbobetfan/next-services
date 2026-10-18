// fetch-boundaries.mjs — fetches the outline of every UK motorway services
// from OpenStreetMap and matches them to service-stations.json.
//
// OpenStreetMap maps each services site as an area tagged highway=services,
// covering its car parks, buildings and forecourt but not the motorway
// itself. The iOS app uses these outlines to tell someone parked at a
// services from someone queuing on the carriageway beside it.
//
// Produces service-boundaries.json. Copy it into the iOS app's
// MotorwayStop/MotorwayStop/ folder (it's bundled automatically). Stations
// without an outline fall back to a distance check in the app.
//
// Run: npm run fetch-boundaries
//      npm run fetch-boundaries -- --from-file raw/osm-services.json
//          (re-use a saved Overpass response instead of downloading)
//      npm run fetch-boundaries -- --out ../../motorway-stop-app/MotorwayStop/MotorwayStop/service-boundaries.json
//
// Data © OpenStreetMap contributors, available under the Open Database
// Licence. The app credits this in Settings ▸ About.

import fs from 'node:fs/promises';
import path from 'node:path';

const STATIONS_FILE = './service-stations.json';
const RAW_FILE = './raw/osm-services.json';
const DEFAULT_OUTPUT_FILE = './service-boundaries.json';

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

// Every highway=services area in Great Britain and Northern Ireland, with
// geometry included so no second lookup is needed.
const QUERY = `
[out:json][timeout:180];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
  way["highway"="services"](area.uk);
  relation["highway"="services"](area.uk);
);
out geom;
`;

// An outline is assigned to its nearest station, if that station is within
// this distance of the outline. Generous enough for split sites, where our
// station point can sit on the carriageway between the two sides.
const MATCH_RADIUS_KM = 1.0;

// 5 decimal places is about 1 m, plenty for telling car park from carriageway.
const COORD_DECIMALS = 5;

// Words that don't identify a particular services, ignored when checking an
// outline's OSM name against the station's name.
const GENERIC_WORDS = new Set([
    'services', 'service', 'station', 'area', 'motorway', 'with',
    'north', 'south', 'east', 'west',
    'northbound', 'southbound', 'eastbound', 'westbound',
    'moto', 'roadchef', 'welcome', 'break', 'extramsa', 'extra', 'westmorland',
]);

// The distinctive words in a name, e.g. "Lancaster (Forton)" → lancaster,
// forton.
function nameTokens(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length >= 4 && !GENERIC_WORDS.has(word));
}

// An outline counts only if its OSM name contains one of the station name's
// distinctive words. Stops nearby business parks, petrol stations and
// unnamed areas also tagged highway=services from being treated as part of
// the services.
function namesMatch(stationName, osmName) {
    const osm = osmName.toLowerCase();
    return nameTokens(stationName).some(token => osm.includes(token));
}

// Same outline regardless of where its ring starts or which way it runs.
// Sites mapped both as separate areas and as a group relation would
// otherwise be listed twice.
const ringKey = ring => ring.map(([lat, lng]) => `${lat},${lng}`).sort().join('|');

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

// Ray casting, treating lat/lng as flat — fine at the scale of a services.
function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [latI, lngI] = ring[i];
        const [latJ, lngJ] = ring[j];
        if ((latI > lat) !== (latJ > lat)) {
            const crossLng = lngI + (lat - latI) / (latJ - latI) * (lngJ - lngI);
            if (lng < crossLng) inside = !inside;
        }
    }
    return inside;
}

// Distance from a station to an outline: 0 if inside, otherwise to the
// nearest corner. Corners are close enough together for matching.
function distanceToRingKm(lat, lng, ring) {
    if (pointInRing(lat, lng, ring)) return 0;
    return Math.min(...ring.map(([pLat, pLng]) => haversineKm(lat, lng, pLat, pLng)));
}

const pointKey = p => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

function isClosed(points) {
    return points.length >= 4 && pointKey(points[0]) === pointKey(points[points.length - 1]);
}

// A relation's outer edge is often split across several ways. Join them end
// to end (reversing where needed) into closed rings. Pieces that don't close
// are dropped.
function assembleRings(segments) {
    const rings = [];
    const remaining = segments.filter(s => s.length >= 2).map(s => [...s]);

    while (remaining.length > 0) {
        let ring = remaining.shift();

        let extended = true;
        while (!isClosed(ring) && extended) {
            extended = false;
            const endKey = pointKey(ring[ring.length - 1]);
            for (let i = 0; i < remaining.length; i++) {
                const seg = remaining[i];
                if (pointKey(seg[0]) === endKey) {
                    ring = ring.concat(seg.slice(1));
                } else if (pointKey(seg[seg.length - 1]) === endKey) {
                    ring = ring.concat([...seg].reverse().slice(1));
                } else {
                    continue;
                }
                remaining.splice(i, 1);
                extended = true;
                break;
            }
        }

        if (isClosed(ring)) rings.push(ring);
    }
    return rings;
}

// Turns Overpass elements into outlines: { osmId, name, ring: [[lat, lng], ...] }.
function extractOutlines(elements) {
    const outlines = [];
    let skipped = 0;

    for (const el of elements) {
        let rings = [];
        if (el.type === 'way' && Array.isArray(el.geometry)) {
            if (isClosed(el.geometry)) rings = [el.geometry];
        } else if (el.type === 'relation' && Array.isArray(el.members)) {
            const outers = el.members
                .filter(m => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry))
                .map(m => m.geometry);
            rings = assembleRings(outers);
        }

        if (rings.length === 0) {
            skipped++;
            continue;
        }

        for (const ring of rings) {
            const rounded = ring
                .slice(0, -1)  // the closing point repeats the first
                .map(p => [Number(p.lat.toFixed(COORD_DECIMALS)), Number(p.lon.toFixed(COORD_DECIMALS))]);
            outlines.push({
                osmId: `${el.type}/${el.id}`,
                name: el.tags?.name || '(unnamed)',
                ring: rounded,
            });
        }
    }
    return { outlines, skipped };
}

async function loadOverpass(fromFile) {
    if (fromFile) {
        console.log(`📂 Reading saved Overpass response from ${fromFile}...`);
        return JSON.parse(await fs.readFile(fromFile, 'utf-8'));
    }

    console.log(`🌍 Querying Overpass (${OVERPASS_URL})... this can take a minute`);
    const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'next-services-pipeline/1.0 (fetch-boundaries)',
        },
        body: `data=${encodeURIComponent(QUERY)}`,
        signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) {
        throw new Error(`Overpass request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const data = await response.json();

    // Keep a copy so re-runs (e.g. after tweaking matching) needn't download again.
    await fs.mkdir(path.dirname(RAW_FILE), { recursive: true });
    await fs.writeFile(RAW_FILE, JSON.stringify(data));
    console.log(`   Saved raw response to ${RAW_FILE}`);
    return data;
}

function parseArgs(argv) {
    const args = { fromFile: null, out: DEFAULT_OUTPUT_FILE };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--from-file') args.fromFile = argv[++i];
        else if (argv[i] === '--out') args.out = argv[++i];
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const stations = JSON.parse(await fs.readFile(STATIONS_FILE, 'utf-8'));
    console.log(`📂 Loaded ${stations.length} stations`);

    const data = await loadOverpass(args.fromFile);
    const { outlines, skipped } = extractOutlines(data.elements || []);
    console.log(`   ${outlines.length} outlines found (${skipped} elements had no usable area)`);

    // Assign each outline to its nearest station within the match radius,
    // if the names agree.
    const byStation = new Map();  // station id → [{ osmId, name, ring, km }]
    const seenRings = new Set();
    const rejected = [];
    let unmatched = 0;
    let duplicates = 0;
    for (const outline of outlines) {
        const key = ringKey(outline.ring);
        if (seenRings.has(key)) {
            duplicates++;
            continue;
        }
        seenRings.add(key);

        let best = null;
        for (const station of stations) {
            const km = distanceToRingKm(station.latitude, station.longitude, outline.ring);
            if (!best || km < best.km) best = { station, km };
        }
        if (!best || best.km > MATCH_RADIUS_KM) {
            unmatched++;
            continue;
        }
        if (!namesMatch(best.station.name, outline.name)) {
            rejected.push({ station: best.station, ...outline, km: best.km });
            continue;
        }
        if (!byStation.has(best.station.id)) byStation.set(best.station.id, []);
        byStation.get(best.station.id).push({ ...outline, km: best.km });
    }

    console.log('');
    console.log('🔗 Matches (check the OSM names look right):');
    for (const station of stations) {
        const matches = byStation.get(station.id);
        if (!matches) continue;
        const detail = matches
            .map(m => `${m.name} [${m.osmId}, ${(m.km * 1000).toFixed(0)} m]`)
            .join('; ');
        console.log(`   ${station.name}: ${detail}`);
    }

    if (rejected.length > 0) {
        console.log('');
        console.log('🚫 Nearby outlines left out because the name doesn\'t match:');
        for (const r of rejected) {
            console.log(`   ${r.station.name}: ${r.name} [${r.osmId}, ${(r.km * 1000).toFixed(0)} m]`);
        }
    }

    const missing = stations.filter(s => !byStation.has(s.id));
    console.log('');
    console.log(`⚠️  ${missing.length} stations without an outline (the app uses a distance check for these):`);
    for (const station of missing) {
        console.log(`   ${station.name} (${station.id})`);
    }

    const output = {
        generated_at: new Date().toISOString(),
        source: '© OpenStreetMap contributors, ODbL. highway=services areas.',
        stations: Object.fromEntries(
            [...byStation.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([id, matches]) => [id, matches.map(m => m.ring)])
        ),
    };
    await fs.writeFile(args.out, JSON.stringify(output));
    const sizeKB = ((await fs.stat(args.out)).size / 1024).toFixed(1);

    console.log('');
    console.log(`✅ Wrote ${args.out}`);
    console.log(`   ${byStation.size} of ${stations.length} stations have an outline • ${sizeKB} KB`);
    console.log(`   ${unmatched} outlines weren't near any of our stations (other services, or ones we don't list)`);
    console.log(`   ${duplicates} duplicate outlines skipped (sites mapped both as areas and as a group)`);
}

main().catch(err => {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    console.error(`❌ Error: ${err.message}${cause}`);
    process.exit(1);
});
