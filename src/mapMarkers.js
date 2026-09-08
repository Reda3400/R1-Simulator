// App-owned map markers + popups (Leaflet divIcons). Pure rendering —
// no R1 calls, no sim state. Selection/heat thresholds arrive as arguments
// so this module stays decoupled from App.vue refs.
import L from 'leaflet';

export const PALETTE = ['#facc15', '#38bdf8', '#22c55e', '#f472b6', '#fb923c', '#a78bfa', '#2dd4bf', '#f87171', '#e879f9', '#a3e635'];
export function orderColor(o) {
  let h = 0;
  for (const ch of o.id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

export function driverIcon(d, selectedId = null) {
  const sel = d.id === selectedId ? 'box-shadow:0 0 0 2px #fff;' : '';
  const grand = d.type === 'grand';
  const emoji = grand ? '🚐' : '🚕';
  const border = grand ? '#7dd3fc' : '#fff';
  const tag = grand ? 'GRAND' : 'PETIT';
  return L.divIcon({
    className: '', iconSize: [74, 30], iconAnchor: [37, 15],
    html: `<div style="display:flex;align-items:center;gap:4px;background:#000;border:1px solid ${border};padding:2px 6px;white-space:nowrap;border-radius:999px;${sel}">
      <span style="font-size:15px;line-height:1;">${emoji}</span>
      <span style="color:#fff;font:700 10px 'JetBrains Mono',monospace;">${d.id} [${d.seats}/${d.passengerCapacity || d.capacity}]${grand ? `<span style="color:#7dd3fc"> G</span>` : ''}${d.deciderId ? ' ★' : ''}</span>
    </div>`,
  });
}

export function pickupIcon(o, selectedOrderId = null, heatSec = 300) {
  const c = orderColor(o);
  const sel = o.id === selectedOrderId ? 'box-shadow:0 0 0 2px #fff;' : '';
  if (o.status === 'canceled') {
    return L.divIcon({ className: '', iconSize: [78, 30], iconAnchor: [12, 15],
      html: `<div style="display:flex;align-items:center;gap:4px;background:#000;border:1px solid #555;padding:2px 6px;white-space:nowrap;border-radius:999px;opacity:0.6;${sel}">
        <span style="font-size:14px;line-height:1;">✕</span>
        <span style="color:#888;font:700 10px 'JetBrains Mono',monospace;">${o.id}</span></div>` });
  }
  const heat = o.status === 'waiting' && (o.ageSec || 0) >= heatSec;
  return L.divIcon({ className: '', iconSize: [78, 30], iconAnchor: [12, 15],
    html: `<div style="display:flex;align-items:center;gap:4px;background:#000;border:2px solid ${heat ? '#ef4444' : c};padding:2px 6px;white-space:nowrap;border-radius:999px;${sel}${heat ? 'animation:r1pulse 1s infinite;' : ''}">
      <span style="font-size:14px;line-height:1;">${heat ? '🔥' : '🧍'}</span>
      <span style="color:${heat ? '#ef4444' : c};font:700 10px 'JetBrains Mono',monospace;">${o.id}</span></div>` });
}

export function dropIcon(o) {
  const c = orderColor(o);
  return L.divIcon({ className: '', iconSize: [74, 30], iconAnchor: [12, 15],
    html: `<div style="display:flex;align-items:center;gap:4px;background:#000;border:1px dashed ${c};padding:2px 6px;white-space:nowrap;border-radius:999px;">
      <span style="font-size:14px;line-height:1;">🏁</span>
      <span style="color:${c};font:700 10px 'JetBrains Mono',monospace;">${o.id}</span></div>` });
}

export function orderPopup(o, fmtAge, heatSec = 300) {
  const road = o.osrm === 'ok' ? '🛣️ R1 road path ✓' : o.osrm === 'loading' ? '🛣️ R1 routing…' : o.osrm === 'fail' ? '🛣️ R1 unreachable — retry' : '';
  const heat = o.status === 'waiting' && (o.ageSec || 0) >= heatSec;
  const phase = o.status !== 'waiting' ? '' : heat ? `🔥 <b>HEAT</b> — nearest taxi forced` : `phase 1 normal (${fmtAge(heatSec - (o.ageSec || 0))} left)`;
  const dem = `${o.passengers} pax${o.bags ? `, ${o.bags} bags` : ''}${o.priority ? `, prio ${o.priority}` : ''}${o.private ? ', 🔒 private' : ''}`;
  const grp = (o.taxis && o.taxis.length) ? `taxi${o.taxis.length > 1 ? 's' : ''}: ${o.taxis.join(', ')} (${o.served || 0}/${o.passengers})` : '';
  return `<b>${o.status === 'canceled' ? '✕' : heat ? '🔥' : '🧍'} Order ${o.id}</b> · ${o.status} · ${o.state}<br>
    <b>FROM:</b> <span style="font-family:monospace">${o.pickup.lat.toFixed(5)}, ${o.pickup.lng.toFixed(5)}</span><br>
    <b>TO:</b> <span style="font-family:monospace">${o.dropoff.lat.toFixed(5)}, ${o.dropoff.lng.toFixed(5)}</span><br>
    ${o.dropoffLabel} · ${o.directKm} km · fare <b>${o.lockedFare ?? o.fare} MAD</b><br>
    <span style="color:#888">${dem}</span><br>
    waiting ${fmtAge(o.ageSec || 0)}${phase ? ` · ${phase}` : ''}<br>
    ${grp || `taxi: ${o.driverId || '— (in pool)'}`}${road ? `<br>${road}` : ''}<br>
    <span style="color:#888">R1 matched · click icon to edit From/To</span>`;
}
