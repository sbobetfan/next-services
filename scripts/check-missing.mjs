import mapping from './station-mapping.json' with { type: 'json' };
import output from '../data/fuel-prices.json' with { type: 'json' };

const missingStations = Object.keys(mapping.stations)
  .filter(id => output.stations[id] === undefined);
console.log('Stations with no fuel data:', missingStations);

for (const [id, entry] of Object.entries(mapping.stations)) {
  for (const fc of entry.fuel_finder) {
    const got = output.stations[id]?.forecourts?.some(f =>
      (f.direction ?? null) === (fc.direction ?? null) && f.brand === fc.brand);
    if (got !== true) {
      console.log('No prices for:', id, '-', fc.direction ?? 'no direction',
        '-', fc.brand, '-', fc.node_id.slice(0, 12) + '…');
    }
  }
}
