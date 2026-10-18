// fetch-boundaries.mjs — fetches the outline of every UK motorway services
// from OpenStreetMap and matches them to service-stations.json.
//
// OpenStreetMap maps each services site as an area tagged highway=services,
// covering its car parks, buildings and forecourt but not the motorway
// itself. The iOS app uses these outlines to tell someone parked at a
// services from someone queuing on the carriageway beside it.
//
// Each outline records which side of the motorway it serves when its OSM
// name says (e.g. "Tibshelf Services Northbound"), so the app can show the
// right side's fuel price.
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

// An outline is assigned to the nearest station whose name it matches, if
// that station is within this distance of it. The two sides of some sites
// are well apart (e.g. Strensham), and the name check keeps a wide radius
// from picking up unrelated areas.
const MATCH_RADIUS_KM = 2.0;

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

// The side of the motorway an outline serves, from an explicit "Northbound",
// "Southbound" etc. in its OSM name. Bare "North"/"West" are ignored: they're
// usually part of the site's own name (Grantham North, Swansea West).
function directionFromName(name) {
    const match = name.toLowerCase().match(/\b(north|south|east|west)bound\b/);
    return match ? match[1] : null;
}

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

// --- Working out a side when the OSM name doesn't say ---------------------
//
// The UK drives on the left, so each direction's services sits on the left
// of its carriageway: northbound services are west of the motorway,
// eastbound services north of it, and so on. For a site with two outlines,
// each outline's offset from the middle of the site, turned 90° clockwise,
// is the direction its traffic travels. The rule is checked against sites
// whose sides are named before it's used (see inferMissingSides).

// Only use the rule if it agrees with at least this share of named sites.
const SIDE_RULE_MIN_AGREEMENT = 0.9;

// Sides set by hand, for outlines the rules can't work out. Keyed by OSM ID
// as shown in the report; look the ID up on openstreetmap.org to see which
// side it is. Values: 'north', 'south', 'east' or 'west'. On a two-outline
// site, setting one side sets the other to the opposite.
// e.g. 'way/61092092': 'north',
const SIDE_OVERRIDES = {};

function centroid(ring) {
    const lat = ring.reduce((sum, [pLat]) => sum + pLat, 0) / ring.length;
    const lng = ring.reduce((sum, [, pLng]) => sum + pLng, 0) / ring.length;
    return { lat, lng };
}

// Compass bearing from one point to another, in degrees (0 = north).
function bearingDeg(from, to) {
    const dy = (to.lat - from.lat) * 110.57;
    const dx = (to.lng - from.lng) * 111.32 * Math.cos(from.lat * Math.PI / 180);
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

// Whether a motorway runs mainly north–south (signed northbound/southbound)
// or east–west, from the spread of its services. Null when it has too few
// services to tell.
function roadRunsNorthSouth(motorway, stations) {
    const onRoad = stations.filter(s => s.motorway === motorway);
    const lats = onRoad.map(s => s.latitude);
    const lngs = onRoad.map(s => s.longitude);
    const nsKm = (Math.max(...lats) - Math.min(...lats)) * 111;
    const ewKm = (Math.max(...lngs) - Math.min(...lngs)) * 111 * Math.cos((lats[0] ?? 54) * Math.PI / 180);
    if (Math.max(nsKm, ewKm) < 5) return null;
    return nsKm >= ewKm;
}

// The side an outline serves, from its offset bearing from the middle of
// the site. Null when it's too diagonal to call.
function sideFromOffset(offsetDeg, runsNorthSouth) {
    const travel = ((offsetDeg + 90) % 360) * Math.PI / 180;
    const north = Math.cos(travel);
    const east = Math.sin(travel);
    const useNorthSouth = runsNorthSouth ?? Math.abs(north) >= Math.abs(east);
    const component = useNorthSouth ? north : east;
    if (Math.abs(component) < 0.3) return null;
    if (useNorthSouth) return north > 0 ? 'north' : 'south';
    return east > 0 ? 'east' : 'west';
}

// The motorway's direction at a station, as a unit vector { east, north }
// pointing the way that's signed north (or east), from the bearing between
// the two nearest other services on the same motorway. Null when the road
// has too few services, or bends too much there to tell.
function localRoadDirection(station, stations) {
    const baseName = name => name.replace(/\s*\(?(north|south|east|west)\)?$/i, '');
    const neighbours = stations
        .filter(s => s.motorway === station.motorway
            && s.id !== station.id
            && baseName(s.name) !== baseName(station.name))
        .map(s => ({ s, km: haversineKm(station.latitude, station.longitude, s.latitude, s.longitude) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 2)
        .map(n => n.s);
    if (neighbours.length < 2) return null;

    const [a, b] = neighbours;
    const kmPerLng = 111.32 * Math.cos(station.latitude * Math.PI / 180);
    let east = (b.longitude - a.longitude) * kmPerLng;
    let north = (b.latitude - a.latitude) * 110.57;
    const length = Math.hypot(east, north);
    if (length < 1) return null;
    east /= length;
    north /= length;

    const runsNorthSouth = roadRunsNorthSouth(station.motorway, stations) ?? Math.abs(north) >= Math.abs(east);
    const along = runsNorthSouth ? north : east;
    if (Math.abs(along) < 0.3) return null;
    if (along < 0) {
        east = -east;
        north = -north;
    }
    return { east, north, positive: runsNorthSouth ? 'north' : 'east' };
}

// Sides for a two-outline site: which side of the motorway's line each
// outline is on. Services on the left of the north-(or east-)going
// carriageway serve that direction. Unaffected by the two sides being
// staggered along the road. Falls back to sidesByOffset when the road's
// direction there is unknown. Null if they can't be told apart.
function sidesByPosition(pair, station, stations) {
    const [a, b] = pair.map(m => centroid(m.ring));
    if (haversineKm(a.lat, a.lng, b.lat, b.lng) < 0.05) return null;

    const road = localRoadDirection(station, stations);
    if (!road) return sidesByOffset(pair, roadRunsNorthSouth(station.motorway, stations));

    const middle = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const kmPerLng = 111.32 * Math.cos(middle.lat * Math.PI / 180);
    // Distance to the left of the road's line (negative: to the right).
    const leftKm = c => road.east * (c.lat - middle.lat) * 110.57
        - road.north * (c.lng - middle.lng) * kmPerLng;
    const leftA = leftKm(a);
    const leftB = leftKm(b);
    // Each must be clearly on its own side (at least 20 m from the line).
    if (Math.abs(leftA) < 0.02 || Math.sign(leftA) === Math.sign(leftB)) return null;

    const sideFor = left => (left > 0 ? road.positive : OPPOSITE[road.positive]);
    return [sideFor(leftA), sideFor(leftB)];
}

// Fallback: sides from the outlines' positions relative to each other. Null
// if they can't be told apart (too diagonal, or not on opposite sides).
function sidesByOffset(pair, runsNorthSouth) {
    const [a, b] = pair.map(m => centroid(m.ring));
    if (haversineKm(a.lat, a.lng, b.lat, b.lng) < 0.05) return null;
    const middle = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const sideA = sideFromOffset(bearingDeg(middle, a), runsNorthSouth);
    const sideB = sideFromOffset(bearingDeg(middle, b), runsNorthSouth);
    if (!sideA || !sideB || OPPOSITE[sideA] !== sideB) return null;
    return [sideA, sideB];
}

// Fills in missing sides on two-outline sites. Where one outline is named,
// the other is its opposite. Where neither is, the drive-on-the-left rule is
// used, but only if it agrees with the sites whose sides are named.
// Marks filled-in outlines with inferred: true.
function inferMissingSides(byStation, stations) {
    const twoOutlineSites = stations
        .map(station => ({ station, matches: byStation.get(station.id) || [] }))
        .filter(({ matches }) => matches.length === 2);

    // 1. One side named: the other is the opposite.
    for (const { matches } of twoOutlineSites) {
        const [a, b] = matches;
        if (a.direction && !b.direction) Object.assign(b, { direction: OPPOSITE[a.direction], inferred: true });
        else if (b.direction && !a.direction) Object.assign(a, { direction: OPPOSITE[b.direction], inferred: true });
    }

    // 2. Check the rule against sites with both sides named.
    let checked = 0;
    let agreed = 0;
    const disagreements = [];
    for (const { station, matches } of twoOutlineSites) {
        if (!matches.every(m => m.direction && !m.inferred)) continue;
        const sides = sidesByPosition(matches, station, stations);
        if (!sides) continue;
        checked++;
        if (sides[0] === matches[0].direction && sides[1] === matches[1].direction) agreed++;
        else disagreements.push(`${station.name}: named ${matches.map(m => m.direction).join('/')}, rule says ${sides.join('/')}`);
    }

    console.log('');
    console.log(`🧭 Drive-on-the-left rule checked on ${checked} sites with named sides: ${agreed} agree`);
    for (const line of disagreements) console.log(`   ✗ ${line}`);

    const trustRule = checked > 0 && agreed / checked >= SIDE_RULE_MIN_AGREEMENT;
    if (!trustRule) {
        console.log('   Not reliable enough here, so sides are left unknown for unnamed outlines.');
        return;
    }

    // 3. Apply it to sites where neither side is named.
    const inferred = [];
    const undecided = [];
    for (const { station, matches } of twoOutlineSites) {
        if (matches.some(m => m.direction)) continue;
        const sides = sidesByPosition(matches, station, stations);
        if (!sides) {
            undecided.push(`${station.name} (${matches.map(m => m.osmId).join(', ')})`);
            continue;
        }
        matches.forEach((m, i) => Object.assign(m, { direction: sides[i], inferred: true }));
        inferred.push(station.name);
    }
    console.log(`   Used it for ${inferred.length} sites with unnamed sides${inferred.length ? `: ${inferred.join(', ')}` : ''}`);
    if (undecided.length > 0) {
        console.log(`   Couldn't tell the sides apart at: ${undecided.join('; ')}`);
        console.log('   Add these to SIDE_OVERRIDES to set them by hand.');
    }
}

// Applies SIDE_OVERRIDES, after any inferred sides so a hand-set side wins.
// On a two-outline site, the other outline gets the opposite side unless it
// is named or set by hand too.
function applySideOverrides(byStation) {
    const applied = [];
    for (const matches of byStation.values()) {
        for (const m of matches) {
            const side = SIDE_OVERRIDES[m.osmId];
            if (!side) continue;
            Object.assign(m, { direction: side, inferred: false, overridden: true });
            applied.push(`${m.osmId} → ${side}bound`);
        }
        if (matches.length === 2) {
            const [a, b] = matches;
            const fillOpposite = (set, other) => {
                if (set.overridden && !other.overridden && (other.inferred || !other.direction)) {
                    Object.assign(other, { direction: OPPOSITE[set.direction], inferred: true });
                }
            };
            fillOpposite(a, b);
            fillOpposite(b, a);
        }
    }
    if (applied.length > 0) {
        console.log(`✋ Sides set by hand: ${applied.join(', ')}`);
    }
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

        for (const [index, ring] of rings.entries()) {
            const rounded = ring
                .slice(0, -1)  // the closing point repeats the first
                .map(p => [Number(p.lat.toFixed(COORD_DECIMALS)), Number(p.lon.toFixed(COORD_DECIMALS))]);
            const name = el.tags?.name || '(unnamed)';
            outlines.push({
                // Relations with several outlines get #1, #2... so each can
                // be told apart (e.g. in SIDE_OVERRIDES).
                osmId: rings.length > 1 ? `${el.type}/${el.id}#${index + 1}` : `${el.type}/${el.id}`,
                name,
                direction: directionFromName(name),
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

    // Drop duplicate outlines (sites mapped both as separate areas and as a
    // group relation). Keep the copy whose name gives a direction, if any.
    const unique = new Map();  // ring key → outline
    let duplicates = 0;
    for (const outline of outlines) {
        const key = ringKey(outline.ring);
        const existing = unique.get(key);
        if (existing) {
            duplicates++;
            if (!existing.direction && outline.direction) unique.set(key, outline);
            continue;
        }
        unique.set(key, outline);
    }

    // Assign each outline to the nearest station whose name it matches,
    // within the match radius.
    const byStation = new Map();  // station id → [{ osmId, name, direction, ring, km }]
    const rejected = [];
    let unmatched = 0;
    for (const outline of unique.values()) {
        let best = null;
        let nearest = null;  // regardless of name, for the report
        for (const station of stations) {
            const km = distanceToRingKm(station.latitude, station.longitude, outline.ring);
            if (km > MATCH_RADIUS_KM) continue;
            if (!nearest || km < nearest.km) nearest = { station, km };
            if (namesMatch(station.name, outline.name) && (!best || km < best.km)) {
                best = { station, km };
            }
        }
        if (!nearest) {
            unmatched++;
            continue;
        }
        if (!best) {
            rejected.push({ station: nearest.station, ...outline, km: nearest.km });
            continue;
        }
        if (!byStation.has(best.station.id)) byStation.set(best.station.id, []);
        byStation.get(best.station.id).push({ ...outline, km: best.km });
    }

    inferMissingSides(byStation, stations);
    applySideOverrides(byStation);

    console.log('');
    console.log('🔗 Matches (check the OSM names look right):');
    for (const station of stations) {
        const matches = byStation.get(station.id);
        if (!matches) continue;
        const detail = matches
            .map(m => `${m.name} [${m.osmId}, ${(m.km * 1000).toFixed(0)} m${m.direction ? `, ${m.direction}bound${m.inferred ? ' (inferred)' : ''}${m.overridden ? ' (set by hand)' : ''}` : ''}]`)
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

    // A site with e.g. a northbound outline but no southbound one is probably
    // missing a side (mapped under another name or tag, or not mapped).
    const oneSided = [];
    for (const station of stations) {
        // Split sites listed as one station per side, e.g. "Sedgemoor
        // (South)", only ever have their own side.
        if (/(\(| )(north|south|east|west)\)?$/i.test(station.name)) continue;
        const directions = new Set((byStation.get(station.id) || []).map(m => m.direction).filter(Boolean));
        for (const direction of directions) {
            if (!directions.has(OPPOSITE[direction])) {
                oneSided.push(`${station.name}: has ${direction}bound but no ${OPPOSITE[direction]}bound outline`);
            }
        }
    }
    if (oneSided.length > 0) {
        console.log('');
        console.log('↔️  Sites with only one side found (users on the other side won\'t be recognised there):');
        for (const line of oneSided) console.log(`   ${line}`);
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
                .map(([id, matches]) => [
                    id,
                    matches.map(m => (m.direction
                        ? { direction: m.direction, points: m.ring }
                        : { points: m.ring })),
                ])
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
