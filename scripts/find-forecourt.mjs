import 'dotenv/config';

const auth = await (await fetch('https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        client_id: process.env.FUEL_FINDER_CLIENT_ID,
        client_secret: process.env.FUEL_FINDER_CLIENT_SECRET,
    }),
})).json();
const token = auth.data.access_token;

const needles = (process.argv[2] ?? 'durham,pont abraham').toLowerCase().split(',');
let batch = 1;

while (true) {
    const res = await fetch(`https://www.fuel-finder.service.gov.uk/api/v1/pfs?batch-number=${batch}`, {
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.status === 404) break;
    if (res.status !== 200) { console.log(`Batch ${batch}: HTTP ${res.status}, stopping`); break; }
    const data = await res.json();
    const fcs = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Object.values(data);

    for (const fc of fcs) {
        const hay = `${fc.node_id} ${fc.trading_name ?? ''} ${JSON.stringify(fc.location ?? '')}`.toLowerCase();
        if (needles.some(n => hay.includes(n.trim()))) {
            console.log(`Batch ${batch}:`, fc.node_id,
                '|', fc.trading_name, '|', fc.brand_name,
                '| motorway:', fc.is_motorway_service_station,
                '| location:', JSON.stringify(fc.location));
        }
    }
    await new Promise(r => setTimeout(r, 400));
    batch++;
}
console.log('Done.');
