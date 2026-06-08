/* ============================================================================
   flight-decoder.js \u2014 dependency-free DJI flight-file decoder for the operator
   submission form. Validates and summarises .SRT and .TXT files entirely in the
   browser, mirroring the VECTOR app's parsers (parseSRT + decodeDjiTxt) but with
   no React / no shared-schema dependency, so it runs inside the standalone form.

     window.FlightDecoder.decode(File) -> Promise<summary>

   summary = {
     ok, kind:'SRT'|'TXT', name,
     model,            // 'Matrice 4E' | 'Mavic Air 3S' | null   (auto-detected)
     encrypted,        // true for AES DJI .txt that needs server-side keys
     dateISO,          // 'YYYY-MM-DD' when the file carries absolute time (SRT)
     startTime,        // 'HH:MM'      (SRT)
     durationSec, samples, distanceM, maxAltM,
     home: {lat,lon} | null,
     serial,           // from a .txt details record, when present
     note, error,
   }
   ============================================================================ */
(function () {
  const RAD2DEG = 180 / Math.PI;

  // Where to send ENCRYPTED .txt logs for server-side decode \u2192 CSV. Set this to your
  // deployed decrypt-service URL (see decrypt-service/). Empty = no decrypt (encrypted
  // logs are still captured and uploaded raw, marked server-side).
  const endpoint = () => String(window.DECRYPT_ENDPOINT || '').trim();

  function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const la1 = a.lat * toR, la2 = b.lat * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // Air 3S wide lens = fixed f/1.8; Matrice 4E aperture never opens below f/2.8.
  function detectModel(fnums) {
    const v = fnums.filter(x => typeof x === 'number' && isFinite(x) && x > 0);
    if (!v.length) return null;
    return Math.min.apply(null, v) <= 2.2 ? 'Mavic Air 3S' : 'Matrice 4E';
  }

  function summarise(frames, base) {
    let dist = 0, maxAlt = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (i > 0) dist += haversine(frames[i - 1], f);
      if (f.relAlt != null && f.relAlt > maxAlt) maxAlt = f.relAlt;
    }
    return Object.assign({
      ok: true, samples: frames.length, frames,   // frames retained so the tool can write a CSV
      distanceM: Math.round(dist), maxAltM: Math.round(maxAlt * 10) / 10,
      home: { lat: +frames[0].lat.toFixed(6), lon: +frames[0].lon.toFixed(6) },
    }, base);
  }

  /* ---- SRT (DJI per-frame telemetry subtitles) ---- */
  function decodeSRT(text, name) {
    const lines = text.split('\n');
    const frames = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.indexOf('latitude') < 0) continue;
      const g = (re) => { const m = ln.match(re); return m ? parseFloat(m[1]) : null; };
      const lat = g(/latitude:\s*(-?[\d.]+)/), lon = g(/longitude:\s*(-?[\d.]+)/);
      if (lat == null || lon == null) continue;
      const ctx = (lines[i - 1] || '') + ' ' + ln;
      const tm = ctx.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.?\d*)/);
      frames.push({
        t: tm ? Date.parse(tm[1].replace(' ', 'T')) : frames.length * 33,
        lat, lon,
        relAlt: g(/rel_alt:\s*(-?[\d.]+)/) ?? 0,
        fnum: g(/fnum:\s*([\d.]+)/),
      });
    }
    if (frames.length < 2) return { ok: false, kind: 'SRT', name, error: 'No GPS telemetry found in this .SRT' };
    const t0 = frames[0].t, t1 = frames[frames.length - 1].t;
    const d0 = new Date(t0);
    const z = (x) => String(x).padStart(2, '0');
    return summarise(frames, {
      kind: 'SRT', name, encrypted: false,
      model: detectModel(frames.map(f => f.fnum)),
      dateISO: isFinite(t0) ? `${d0.getFullYear()}-${z(d0.getMonth() + 1)}-${z(d0.getDate())}` : null,
      startTime: isFinite(t0) ? `${z(d0.getHours())}:${z(d0.getMinutes())}` : null,
      durationSec: Math.max(0, Math.round((t1 - t0) / 1000)),
    });
  }

  /* ---- DJI .TXT container walk (unencrypted records) ---- */
  function rd(dv, o) {
    return { u8: k => dv.getUint8(o + k), i16: k => dv.getInt16(o + k, true), f64: k => dv.getFloat64(o + k, true) };
  }
  function osdLatLon(r) {
    const lon = r.f64(0) * RAD2DEG, lat = r.f64(8) * RAD2DEG;
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return null;
    return { lat, lon };
  }
  function decodeTXT(buf, name) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    if (u8.length < 100) return { ok: false, kind: 'TXT', name, error: 'File too small to be a DJI log' };
    const detailOffset = Number(dv.getBigUint64(0, true));
    const recStart = 12;
    const recEnd = (detailOffset > recStart && detailOffset <= u8.length) ? detailOffset : u8.length;
    const osd = [];
    let i = recStart, bad = 0;
    while (i + 2 <= recEnd) {
      const type = u8[i], len = u8[i + 1], ps = i + 2, pe = ps + len;
      if (len === 0 || pe + 1 > recEnd) { bad++; i++; if (bad > 4096) break; continue; }
      if (u8[pe] !== 0xff) { bad++; i++; if (bad > 4096) break; continue; }
      if (type === 1 && len >= 30) {
        try {
          const r = rd(dv, ps); const ll = osdLatLon(r);
          if (ll) { const alt = r.i16(16) / 10; if (alt >= -500 && alt <= 12000) osd.push({ t: osd.length * 100, lat: ll.lat, lon: ll.lon, relAlt: alt }); }
        } catch (e) {}
      }
      i = pe + 1;
    }
    // details (plaintext aircraft/serial \u2014 readable even in encrypted logs)
    let cur = '', strings = [];
    for (let k = recEnd; k < u8.length; k++) { const c = u8[k]; if (c >= 32 && c < 127) cur += String.fromCharCode(c); else { if (cur.length >= 4) strings.push(cur); cur = ''; } }
    if (cur.length >= 4) strings.push(cur);
    const join = strings.join(' ');
    const serialM = join.match(/\b([0-9A-Z]{10,18})\b/);
    const modelM = join.match(/(Matrice\s*4E?|Mavic\s*Air\s*3S?)/i);
    const model = modelM ? (/air\s*3s/i.test(modelM[1]) ? 'Mavic Air 3S' : 'Matrice 4E') : null;
    const serial = serialM ? serialM[1] : null;

    if (osd.length < 10) {
      // Encrypted modern DJI Fly / Pilot 2 log \u2014 keys are server-side.
      return { ok: true, kind: 'TXT', name, encrypted: true, model, serial,
        note: 'Encrypted DJI log \u2014 telemetry decodes server-side; the file is still captured.' };
    }
    const HZ = 10;
    return summarise(osd, {
      kind: 'TXT', name, encrypted: false, model, serial,
      dateISO: null, startTime: null,
      durationSec: Math.round(osd.length / HZ),
    });
  }

  /* ---- POST an encrypted .txt to the decrypt service \u2192 decoded CSV ---- */
  async function decryptViaEndpoint(file, base) {
    const ep = endpoint();
    const r = await fetch(ep, { method: 'POST', body: file, headers: { 'X-Filename': file.name, 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) throw new Error('Decrypt service ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const csv = await r.text();
    const rows = Math.max(0, csv.split('\n').filter(l => l.trim()).length - 1); // minus header
    return Object.assign({}, base, {
      encrypted: true, decrypted: true, csv, samples: rows,
      model: r.headers.get('X-Model') || base.model || null,
      serial: r.headers.get('X-Serial') || base.serial || null,
      note: 'Decrypted server-side \u2192 CSV.',
    });
  }

  /* ---- Build a per-flight CSV from decoded frames (SRT / legacy TXT). For a
     server-decrypted log the CSV already exists (result.csv) and is returned as-is. ---- */
  function toCSV(result, meta) {
    if (result && result.csv) return result.csv;          // server-decrypted: already CSV
    meta = meta || {};
    const fr = (result && result.frames) || [];
    const head = `# Arealytics flight CSV  \u00b7  operator=${meta.operator || ''}  date=${meta.dateISO || result.dateISO || ''}  model=${result.model || ''}  serial=${result.serial || ''}  source=${result.kind || ''}\n`;
    const cols = 'time_s,latitude,longitude,rel_alt_m,h_speed_ms,v_speed_ms,distance_m';
    if (fr.length < 2) return head + cols + '\n';
    const tof = (f, i) => (f.t != null && isFinite(f.t)) ? f.t : i * 100;
    const t0 = tof(fr[0], 0);
    const span = tof(fr[fr.length - 1], fr.length - 1) - t0;
    const dtAvg = span / Math.max(1, fr.length - 1);
    const step = Math.max(1, Math.round(500 / Math.max(1, dtAvg)));   // ~0.5 s rows
    let dist = 0, prev = null; const lines = [];
    for (let i = 0; i < fr.length; i += step) {
      const f = fr[i], t = tof(f, i);
      let hs = 0, vs = 0;
      if (prev) {
        const dt = Math.max(0.001, (t - prev.t) / 1000);
        const d = haversine(prev, f); dist += d;
        hs = d / dt; vs = ((f.relAlt || 0) - prev.relAlt) / dt;
      }
      lines.push([((t - t0) / 1000).toFixed(1), f.lat.toFixed(6), f.lon.toFixed(6),
        (f.relAlt || 0).toFixed(1), hs.toFixed(2), vs.toFixed(2), Math.round(dist)].join(','));
      prev = { lat: f.lat, lon: f.lon, relAlt: f.relAlt || 0, t };
    }
    return head + cols + '\n' + lines.join('\n') + '\n';
  }

  async function decode(file) {
    const lower = (file.name || '').toLowerCase();
    try {
      if (lower.endsWith('.srt')) return decodeSRT(await file.text(), file.name);
      if (lower.endsWith('.txt')) {
        const res = decodeTXT(await file.arrayBuffer(), file.name);
        // Encrypted modern log + a decrypt service configured \u2192 decode there into CSV.
        if (res.ok && res.encrypted && endpoint()) {
          try { return await decryptViaEndpoint(file, res); }
          catch (e) { return Object.assign({}, res, { decryptError: String(e && e.message || e) }); }
        }
        return res;
      }
      return { ok: false, kind: '?', name: file.name, error: 'Unsupported file type' };
    } catch (e) {
      return { ok: false, kind: lower.endsWith('.txt') ? 'TXT' : 'SRT', name: file.name, error: String(e && e.message || e) };
    }
  }

  window.FlightDecoder = { decode, detectModel, toCSV, decryptViaEndpoint, endpoint };
})();
