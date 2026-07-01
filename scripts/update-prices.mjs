// update-prices.mjs — hourly pipeline that fetches current fuel prices from
// the Fuel Finder API, filters to stations we have mapped, and writes
// ../data/fuel-prices.json for the iOS app to consume.
//
// Run manually: npm run update-prices
// Run via CI: triggered hourly by .github/workflows/update-fuel-prices.yml

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://www.fuel-finder.service.gov.uk';
const MAPPING_FILE = './station-mapping.json';
const OUTPUT_FILE = '../data/fuel-prices.json';
const CLIENT_ID = process.env.FUEL_FINDER_CLIENT_ID;
const CLIENT_SECRET = process.env.FUEL_FINDER_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing credentials in .env');
    process.exit(1);
}

async function getAccessToken() {
    console.log('🔑 Requesting access token...');

    const response = await fetch(`${BASE_URL}/api/v1/oauth/generate_access_token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'next-services-pipeline/1.0 (github-actions)',
        },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        const headers = Object.fromEntries(response.headers.entries());
        console.error('Response headers:', JSON.stringify(headers, null, 2));
        console.error('Response body:', body);
        throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.success || !data.data?.access_token) {
        throw new Error(`Token response malformed: ${JSON.stringify(data)}`);
    }

    console.log(`   ✓ Token acquired`);
    return data.data.access_token;
}

async function fetchPriceBatch(token, batchNumber) {
    const url = `${BASE_URL}/api/v1/pfs/fuel-prices?batch-number=${batchNumber}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
        return { done: true, status: response.status };
    }

    const data = await response.json();

    if (data && data.success === false) {
        return { done: true };
    }

    const forecourts = Array.isArray(data) ? data : data.data;
    if (!Array.isArray(forecourts) || forecourts.length === 0) {
        return { done: true };
    }

    return { done: false, forecourts };
}

async function loadMapping() {
    const mapping = JSON.parse(await fs.readFile(MAPPING_FILE, 'utf-8'));
    const wantedNodeIds = new Set();

    for (const [, entry] of Object.entries(mapping.stations)) {
        for (const fc of entry.fuel_finder) {
            wantedNodeIds.add(fc.node_id);
        }
    }

    return { mapping, wantedNodeIds };
}

async function main() {
    const startTime = Date.now();

    console.log('📂 Loading station mapping...');
    const { mapping, wantedNodeIds } = await loadMapping();
    const stationCount = Object.keys(mapping.stations).length;
    console.log(`   ${wantedNodeIds.size} forecourts to track across ${stationCount} stations`);

    const token = await getAccessToken();

    console.log('📦 Fetching price batches...');
    const priceRecords = new Map();  // node_id → fuel_prices array
    let batchNumber = 1;

    while (true) {
        process.stdout.write(`   Batch ${batchNumber}... `);

        const result = await fetchPriceBatch(token, batchNumber);

        if (result.done) {
            console.log(result.status ? `end (HTTP ${result.status})` : 'end');
            break;
        }

        let matchesInBatch = 0;
        for (const fc of result.forecourts) {
            if (wantedNodeIds.has(fc.node_id)) {
                priceRecords.set(fc.node_id, fc.fuel_prices);
                matchesInBatch++;
            }
        }

        console.log(`${result.forecourts.length} forecourts (${matchesInBatch} matched)`);

        await new Promise(r => setTimeout(r, 500));
        batchNumber++;
    }

    console.log('');
    console.log(`✓ Matched ${priceRecords.size} of ${wantedNodeIds.size} tracked forecourts`);

    console.log('📝 Building output...');

    const outputStations = {};
    let stationsWithData = 0;

    for (const [stationId, entry] of Object.entries(mapping.stations)) {
        const forecourts = [];

        for (const fc of entry.fuel_finder) {
            const prices = priceRecords.get(fc.node_id);
            if (!prices || prices.length === 0) continue;

            const priceMap = {};
            let mostRecentUpdate = null;

            for (const p of prices) {
                priceMap[p.fuel_type] = p.price;
                const updatedAt = new Date(p.price_last_updated);
                if (!mostRecentUpdate || updatedAt > mostRecentUpdate) {
                    mostRecentUpdate = updatedAt;
                }
            }

            forecourts.push({
                direction: fc.direction,
                brand: fc.brand,
                prices: priceMap,
                last_updated: mostRecentUpdate?.toISOString() || null,
            });
        }

        if (forecourts.length > 0) {
            // Sort forecourts: no-direction first, then alphabetical by direction
            forecourts.sort((a, b) => (a.direction || '').localeCompare(b.direction || ''));
            outputStations[stationId] = { forecourts };
            stationsWithData++;
        }
    }

    const output = {
        updated_at: new Date().toISOString(),
        stations: outputStations,
    };

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));

    const stats = await fs.stat(OUTPUT_FILE);
    const sizeKB = (stats.size / 1024).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log(`✅ Wrote ${OUTPUT_FILE}`);
    console.log(`   ${stationsWithData} of ${stationCount} stations have fuel data`);
    console.log(`   ${sizeKB} KB • ${elapsed}s total`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
