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
  const FLEET_SNS = { '1581F7FVC263U00D35JB': 'Matrice 4E',
    '1581FB34C25CE003223N': 'DJI Lito X1', // Lucas Moy
    '1581FB34C25CE0031ZGB': 'DJI Lito X1', // Paul McConnell
  };
  function detectModel(fnums, aircraftSn, rawName) {
    if (aircraftSn && FLEET_SNS[aircraftSn]) return FLEET_SNS[aircraftSn];
    const n = String(rawName || '');
    if (/lito/i.test(n)) return 'DJI Lito X1';
    if (/matrice\s*4/i.test(n)) return 'Matrice 4E';
    if (/flip/i.test(n)) return 'DJI Flip';
    if (/air\s*3s|mavic/i.test(n)) return 'Mavic Air 3S';
    const v = fnums.filter(x => typeof x === 'number' && isFinite(x) && x > 0);
    if (!v.length) return null;
    // Air 3S f/1.8 and Lito X1 f/1.7 BOTH fall under 2.2 — aperture cannot separate them.
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
    if (u8.length < 100) return { ok: false, kind: 'TXT', name, error: 'empty file — no flight data' };
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
    const modelM = join.match(/(Lito\s*X1?|Matrice\s*4E?|DJI\s*Flip|Mavic\s*Air\s*3S?)/i);
    const model = modelM
      ? /lito/i.test(modelM[1]) ? 'DJI Lito X1'
      : /flip/i.test(modelM[1]) ? 'DJI Flip'
      : /air\s*3s/i.test(modelM[1]) ? 'Mavic Air 3S'
      : 'Matrice 4E'
      : null;
    const serial = serialM ? serialM[1] : null;

    if (osd.length < 10) {
      // Encrypted modern DJI Fly / Pilot 2 log \u2014 keys are server-side. But ONLY claim that with
      // positive DJI evidence: the details block is PLAINTEXT even in encrypted logs, so a real one
      // carries a model/serial (and DJI names them ...FlightRecord...). Without any of that, this is
      // a notes file / renamed doc / corrupted log \u2014 a green "ready" tick on garbage fakes validation.
      if (model || serial || /flightrecord/i.test(name)) {
        return { ok: true, kind: 'TXT', name, encrypted: true, model, serial,
          note: 'Encrypted DJI log \u2014 telemetry is processed after upload.' };
      }
      return { ok: false, kind: 'TXT', name, error: 'not a readable DJI flight log' };
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

  /* ---- Matrice 4E video \u2192 telemetry (streamed in-browser; the video itself is NEVER
     uploaded or stored \u2014 only the recovered telemetry text leaves this function). The M4E
     (DJI Pilot 2) embeds per-frame telemetry as a subtitle stream inside the .MP4 instead
     of writing a sidecar .SRT, so we stream the file in chunks and scrape the frames. ---- */
  async function extractM4eSrt(file, onProgress) {
    const M4E_BLOCK = /FrameCnt: \d+ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+[\s\S]{0,500}?abs_alt: [-0-9.]+\]/g;
    const M4E_TS = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/;
    const CHUNK = 16 * 1024 * 1024, OVER = 8192, dec = new TextDecoder('latin1');
    // V8 substring slices RETAIN their parent string: without a hard copy every matched
    // block pins its whole ~32 MB chunk, so a multi-GB video OOMs the tab. Copy hard.
    const te = new TextEncoder(), td = new TextDecoder();
    const hardCopy = (s) => td.decode(te.encode(s));
    let tail = '', blocks = [], seen = new Set();
    for (let pos = 0; pos < file.size; pos += CHUNK) {
      const end = Math.min(file.size, pos + CHUNK);
      const text = tail + dec.decode(new Uint8Array(await file.slice(pos, end).arrayBuffer()));
      M4E_BLOCK.lastIndex = 0; let m;
      while ((m = M4E_BLOCK.exec(text))) {
        const g = m[0], fc = (g.match(/FrameCnt: (\d+)/) || [])[1];
        if (fc == null || seen.has(fc)) continue;
        seen.add(fc); blocks.push(hardCopy(g.trim()));
      }
      tail = hardCopy(text.slice(-OVER));
      if (onProgress) onProgress(Math.round(end / file.size * 100));
      await new Promise(r => setTimeout(r, 0));   // yield so the UI repaints
    }
    return rawBlocksToNativeSrt(blocks);
  }

  /* ---- Reshape raw M4E telemetry blocks into the NATIVE DJI sidecar dialect. The M4E embeds
     "FrameCnt: N <date> [fields]" (0-based, no comma, no <font>, no DiffTime) and downstream
     tools — the VST media ingest above all — REJECT that as "[FrameCnt] absent in all frames".
     Only the Air-style layout is accepted: <font size="28">FrameCnt: N, DiffTime: XXms /
     timestamp on its own line / fields, 1-based. Every SRT this form emits MUST pass through
     here (13 Jul 2026 — this was the last producer still writing the raw dialect). ---- */
  const M4E_RAW_TS = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/;
  const M4E_RAW_HEAD = /^FrameCnt:\s*\d+\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s*([\s\S]*)$/;
  function rawBlocksToNativeSrt(blocks) {
    const parsed = [];
    for (const b of blocks) { const mm = b.match(M4E_RAW_TS); if (mm) parsed.push([Date.parse(mm[1].replace(' ', 'T')), b]); }
    if (parsed.length < 2) return null;
    const t0 = parsed[0][0], pad = (n, w) => String(n).padStart(w, '0');
    const tc = (ms) => { let s = Math.max(0, (ms - t0) / 1000); return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s % 3600 / 60), 2)}:${pad(Math.floor(s % 60), 2)},${pad(Math.round((s - Math.floor(s)) * 1000), 3)}`; };
    let out = '';
    for (let i = 0; i < parsed.length; i++) {
      const nt = i + 1 < parsed.length ? parsed[i + 1][0] : parsed[i][0] + 33;
      const m = parsed[i][1].match(M4E_RAW_HEAD);
      if (!m) continue;
      const diff = Math.max(1, Math.round(i === 0 ? nt - parsed[i][0] : parsed[i][0] - parsed[i - 1][0]));
      const fields = m[2].replace(/\s+/g, ' ').trim();
      out += `${i + 1}\n${tc(parsed[i][0])} --> ${tc(nt)}\n<font size="28">FrameCnt: ${i + 1}, DiffTime: ${diff}ms\n${m[1]}\n${fields} </font>\n\n`;
    }
    return out || null;
  }
  // A raw-dialect SRT from ANY outside tool (plain ffmpeg pull etc.) — normalise it too.
  const isRawDialect = (text) => /FrameCnt: \d+ \d{4}-/.test(text) && !/<font size="28">FrameCnt: \d+,/.test(text);
  function normalizeRawSrt(text) {
    const RAW = /FrameCnt: \d+ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+[\s\S]{0,500}?abs_alt: [-0-9.]+\]/g;
    const blocks = []; let m;
    while ((m = RAW.exec(text))) blocks.push(m[0].trim());
    return blocks.length > 1 ? rawBlocksToNativeSrt(blocks) : null;
  }

  async function decode(file, onProgress) {
    const lower = (file.name || '').toLowerCase();
    try {
      if (lower.endsWith('.srt')) {
        const text = await file.text();
        // BACKSTOP: an .srt in the raw M4E dialect (made by a plain ffmpeg pull or an old
        // extractor) is normalised to the native sidecar dialect HERE, so the healed version
        // is what gets uploaded — the raw one never reaches the Drive or the VST again.
        if (isRawDialect(text)) {
          const conv = normalizeRawSrt(text);
          if (conv) {
            const res = decodeSRT(conv, file.name);
            if (res.ok) return Object.assign(res, { kind: 'M4E', model: 'Matrice 4E', extractedSrt: conv });
          }
        }
        return decodeSRT(text, file.name);
      }
      if (lower.endsWith('.mp4') || lower.endsWith('.mov')) {
        const srt = await extractM4eSrt(file, onProgress);
        if (!srt) return { ok: false, kind: 'M4E', name: file.name, error: 'No embedded telemetry in this video \u2014 only Matrice 4E videos carry it' };
        const res = decodeSRT(srt, file.name);
        if (!res.ok) return Object.assign(res, { kind: 'M4E' });
        // Only the M4E embeds telemetry in video, so the model is known (fnum-based
        // detection would misread the M4E's bright lens as an Air 3S).
        return Object.assign(res, { kind: 'M4E', model: 'Matrice 4E', extractedSrt: srt });
      }
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
