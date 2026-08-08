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

for (const path of ['/api/v1/pfs?batch-number=1', '/api/v1/pfs/forecourts?batch-number=1', '/api/v1/pfs/details?batch-number=1']) {
    const res = await fetch('https://www.fuel-finder.service.gov.uk' + path, {
        headers: { 'Authorization': `Bearer ${token}` },
    });
    console.log('---', path, '->', res.status);
    if (!res.ok) continue;

    const data = await res.json();
    const fcs = Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
            : Object.values(data);
    if (!fcs?.[0] || typeof fcs[0] !== 'object') {
        console.log('  (unexpected shape)', Object.keys(data).slice(0, 5));
        continue;
    }

    console.log('  Fields:', Object.keys(fcs[0]));
    const closureish = fcs.filter(fc => Object.keys(fc).some(k => /clos/i.test(k)));
    console.log('  Closure-ish fields present on', closureish.length, 'of', fcs.length);
    if (closureish[0]) {
        const keys = Object.keys(closureish[0]).filter(k => /clos/i.test(k));
        console.log('  Field name(s):', keys, '-> sample value:', keys.map(k => closureish[0][k]));
    }
    break;
}
