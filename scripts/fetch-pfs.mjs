// fetch-pfs.mjs — fetches all PFS (petrol filling station) info batches
// from the Fuel Finder API and saves each batch to raw/pfs-batch-N.json.
//
// Run: npm run fetch-pfs
//
// Only needed for building the initial station mapping. The hourly
// pipeline uses the prices endpoint directly.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://www.fuel-finder.service.gov.uk';
const RAW_DIR = './raw';
const CLIENT_ID = process.env.FUEL_FINDER_CLIENT_ID;
const CLIENT_SECRET = process.env.FUEL_FINDER_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing credentials in .env');
    console.error('   Copy .env.example to .env and add your credentials.');
    process.exit(1);
}

async function getAccessToken() {
    console.log('🔑 Requesting access token...');

    const response = await fetch(`${BASE_URL}/api/v1/oauth/generate_access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        }),
    });

    if (!response.ok) {
        throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.success || !data.data?.access_token) {
        throw new Error(`Token response malformed: ${JSON.stringify(data)}`);
    }

    console.log(`   ✓ Token acquired (expires in ${data.data.expires_in}s)`);
    return data.data.access_token;
}

async function fetchBatch(token, batchNumber) {
    const url = `${BASE_URL}/api/v1/pfs?batch-number=${batchNumber}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
    });

    // 404 or non-200 = probably past the last batch
    if (!response.ok) {
        return { done: true, status: response.status };
    }

    const data = await response.json();

    // The API sometimes returns 200 with { success: false } for "no more data"
    if (data && data.success === false) {
        return { done: true };
    }

    // Data can be at data.data (nested wrapper) or top-level array
    const forecourts = Array.isArray(data) ? data : data.data;
    if (!Array.isArray(forecourts) || forecourts.length === 0) {
        return { done: true };
    }

    return { done: false, forecourts };
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

async function main() {
    await ensureDir(RAW_DIR);
    const token = await getAccessToken();

    console.log('📦 Fetching batches...');
    let batchNumber = 1;
    let totalForecourts = 0;
    let motorwayCount = 0;

    while (true) {
        process.stdout.write(`   Batch ${batchNumber}... `);

        const result = await fetchBatch(token, batchNumber);

        if (result.done) {
            console.log(result.status ? `end (HTTP ${result.status})` : 'end (empty response)');
            break;
        }

        const filePath = path.join(RAW_DIR, `pfs-batch-${batchNumber}.json`);
        await fs.writeFile(filePath, JSON.stringify(result.forecourts, null, 2));

        const inBatch = result.forecourts.length;
        const motorwayInBatch = result.forecourts.filter(f => f.is_motorway_service_station).length;
        totalForecourts += inBatch;
        motorwayCount += motorwayInBatch;

        console.log(`✓ ${inBatch} forecourts (${motorwayInBatch} motorway)`);

        // Polite pause between requests
        await new Promise(r => setTimeout(r, 500));
        batchNumber++;
    }

    console.log('');
    console.log(`✅ Done. Fetched ${totalForecourts} forecourts across ${batchNumber - 1} batches.`);
    console.log(`   Of those, ${motorwayCount} are motorway services.`);
    console.log(`   Raw data saved to ${RAW_DIR}/`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});