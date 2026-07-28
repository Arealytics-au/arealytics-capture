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

  /* ---- DJI Lito X1 video/proxy -> telemetry (streamed in-browser; the file itself is
     NEVER uploaded or stored -- only the recovered telemetry text leaves this function).
     Unlike the M4E (subtitle-text stream) the Lito X1 embeds telemetry as a Protocol
     Buffers-encoded 'djmd' DATA track inside the MP4 container -- no public schema exists
     for this model (confirmed 25 Jul 2026: ExifTool 13.58 recognises the protocol name
     "dvtm_Lito_X1.proto" but returns "Unknown protocol ... please submit sample for
     testing"). The field mapping below was reverse-engineered and VALIDATED against a
     real sample (Lucas Moy's airframe, 24 Jul 2026): decoded GPS position and relative
     altitude matched that same flight's TXT flight record exactly. See
     decrypt/lito_extract.py for the from-scratch server-side twin of this same logic
     and the full validation writeup -- this is a deliberate JS port of already-proven code,
     not a fresh guess. Prefer the .LRF over the .MP4: same telemetry (djmd track is
     identical either way), 1/8th the size, so it's what's actually safe to read in a tab. */

  // -- minimal ISO-BMFF (MP4/MOV) box walker: just enough to find the djmd track's
  //    sample table and slice its raw sample bytes out of the file, in-browser. --
  function readBoxes(dv, start, end) {
    const boxes = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), type = String.fromCharCode(dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7));
      let headerLen = 8;
      if (size === 1) { // 64-bit largesize
        const hi = dv.getUint32(o + 8), lo = dv.getUint32(o + 12);
        size = hi * 4294967296 + lo; headerLen = 16;
      } else if (size === 0) {
        size = end - o; // box extends to end of its parent
      }
      if (size < headerLen || o + size > end) break; // malformed / truncated -- stop, don't throw
      boxes.push({ type, start: o, headerLen, bodyStart: o + headerLen, end: o + size });
      o += size;
    }
    return boxes;
  }
  function findBox(boxes, type) { return boxes.find(b => b.type === type); }

  function findDjmdTrack(fullDv, fileSize) {
    // moov can sit anywhere in the file; scan top-level boxes to find it (mdat is usually
    // much bigger, so read top-level box headers first rather than assuming an offset).
    const top = readBoxes(fullDv, 0, fileSize);
    const moov = findBox(top, 'moov');
    if (!moov) return null;
    const moovKids = readBoxes(fullDv, moov.bodyStart, moov.end);
    for (const trak of moovKids.filter(b => b.type === 'trak')) {
      const trakKids = readBoxes(fullDv, trak.bodyStart, trak.end);
      const mdia = findBox(trakKids, 'mdia'); if (!mdia) continue;
      const mdiaKids = readBoxes(fullDv, mdia.bodyStart, mdia.end);
      const minf = findBox(mdiaKids, 'minf'); if (!minf) continue;
      const minfKids = readBoxes(fullDv, minf.bodyStart, minf.end);
      const stbl = findBox(minfKids, 'stbl'); if (!stbl) continue;
      const stblKids = readBoxes(fullDv, stbl.bodyStart, stbl.end);
      const stsd = findBox(stblKids, 'stsd'); if (!stsd) continue;
      // stsd: version/flags(4) + entry_count(4) + first entry starts with size(4)+fourCC(4)
      const entryFourCC = String.fromCharCode(
        fullDv.getUint8(stsd.bodyStart + 12), fullDv.getUint8(stsd.bodyStart + 13),
        fullDv.getUint8(stsd.bodyStart + 14), fullDv.getUint8(stsd.bodyStart + 15));
      if (entryFourCC !== 'djmd') continue;
      const stsz = findBox(stblKids, 'stsz'), stsc = findBox(stblKids, 'stsc');
      const stco = findBox(stblKids, 'stco') || findBox(stblKids, 'co64');
      if (!stsz || !stsc || !stco) continue;
      return { dv: fullDv, stsz, stsc, stco, isCo64: stco.type === 'co64' };
    }
    return null;
  }

  function sampleByteRanges({ dv, stsz, stsc, stco, isCo64 }) {
    // stsz: ver/flags(4) sampleSize(4) sampleCount(4) [ sizes(4 each) if sampleSize==0 ]
    const uniformSize = dv.getUint32(stsz.bodyStart + 4);
    const sampleCount = dv.getUint32(stsz.bodyStart + 8);
    const sizes = new Array(sampleCount);
    if (uniformSize !== 0) {
      sizes.fill(uniformSize);
    } else {
      for (let i = 0; i < sampleCount; i++) sizes[i] = dv.getUint32(stsz.bodyStart + 12 + i * 4);
    }
    // stco/co64: ver/flags(4) entryCount(4) offsets(4 or 8 each)
    const chunkCount = dv.getUint32(stco.bodyStart + 4);
    const chunkOffsets = new Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      chunkOffsets[i] = isCo64
        ? dv.getUint32(stco.bodyStart + 8 + i * 8) * 4294967296 + dv.getUint32(stco.bodyStart + 12 + i * 8)
        : dv.getUint32(stco.bodyStart + 8 + i * 4);
    }
    // stsc: ver/flags(4) entryCount(4) [firstChunk(4) samplesPerChunk(4) sampleDescIdx(4)]*
    const stscCount = dv.getUint32(stsc.bodyStart + 4);
    const stscEntries = [];
    for (let i = 0; i < stscCount; i++) {
      const o = stsc.bodyStart + 8 + i * 12;
      stscEntries.push({ firstChunk: dv.getUint32(o), samplesPerChunk: dv.getUint32(o + 4) });
    }
    // Standard MP4 sample-to-chunk expansion: each entry's samplesPerChunk applies to every
    // chunk from its firstChunk up to (not including) the next entry's firstChunk.
    const ranges = []; let sampleIdx = 0;
    for (let e = 0; e < stscEntries.length; e++) {
      const first = stscEntries[e].firstChunk;
      const last = e + 1 < stscEntries.length ? stscEntries[e + 1].firstChunk - 1 : chunkCount;
      for (let chunk = first; chunk <= last && chunk <= chunkCount; chunk++) {
        let offset = chunkOffsets[chunk - 1];
        for (let s = 0; s < stscEntries[e].samplesPerChunk; s++) {
          if (sampleIdx >= sampleCount) break;
          ranges.push({ offset, size: sizes[sampleIdx] });
          offset += sizes[sampleIdx];
          sampleIdx++;
        }
      }
    }
    return ranges;
  }

  // -- schema-free protobuf decode: tag = (fieldNum<<3)|wireType. Recurses into
  //    length-delimited fields that themselves look like valid protobuf. JS port of
  //    decrypt/lito_extract.py's _decode_message -- keep the two in sync. --
  function pbReadVarint(u8, i) {
    let result = 0n, shift = 0n;
    while (true) {
      const b = u8[i]; i++;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return [result, i];
      shift += 7n;
    }
  }
  function pbDecodeMessage(u8, dv, base) {
    const out = {}; let i = 0; const n = u8.length;
    if (n === 0) return out;
    while (i < n) {
      let tag, ni; try { [tag, ni] = pbReadVarint(u8, i); } catch (e) { return null; }
      i = ni; const tagN = Number(tag);
      const fieldNum = tagN >>> 3, wireType = tagN & 0x7;
      if (fieldNum === 0) return null;
      if (wireType === 0) {
        let val; try { [val, i] = pbReadVarint(u8, i); } catch (e) { return null; }
        out[fieldNum] = val; // BigInt -- caller converts as needed
      } else if (wireType === 1) {
        if (i + 8 > n) return null;
        out[fieldNum] = dv.getFloat64(base + i, true); i += 8;
      } else if (wireType === 5) {
        if (i + 4 > n) return null;
        out[fieldNum] = dv.getFloat32(base + i, true); i += 4;
      } else if (wireType === 2) {
        let len; try { [len, i] = pbReadVarint(u8, i); } catch (e) { return null; }
        len = Number(len);
        if (i + len > n) return null;
        const chunk = u8.subarray(i, i + len); i += len;
        const nested = pbDecodeMessage(chunk, dv, base + (i - len));
        out[fieldNum] = (nested && Object.keys(nested).length) ? nested : chunk;
      } else {
        return null;
      }
    }
    return out;
  }
  function pbGet(d, ...path) {
    let cur = d;
    for (const p of path) { if (!cur || typeof cur !== 'object' || !(p in cur)) return null; cur = cur[p]; }
    return cur;
  }
  function pbInt64s(v) { // reinterpret a plain-varint BigInt as signed 64-bit
    if (v == null) return null;
    v = BigInt.asIntN(64, v);
    return Number(v);
  }

  // Field paths validated against a real sample's TXT flight record (see docstring above):
  //   3.1.2 = TimeStamp (us)   3.3.4.1.2/.3 = GPS lat/lon (already degrees)
  //   3.3.4.2 = AbsoluteAltitude (int64s, /1000 -> m)   3.3.5.1 = RelativeAltitude (/1000 -> m)
  function decodeLitoFrame(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const msg = pbDecodeMessage(bytes, dv, 0);
    if (!msg) return null;
    const lat = pbGet(msg, 3, 3, 4, 1, 2), lon = pbGet(msg, 3, 3, 4, 1, 3);
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    const absAltRaw = pbGet(msg, 3, 3, 4, 2);
    const relAltRaw = pbGet(msg, 3, 3, 5, 1);
    return {
      lat, lon,
      absAlt: absAltRaw != null ? pbInt64s(absAltRaw) / 1000 : null,
      relAlt: typeof relAltRaw === 'number' ? relAltRaw / 1000 : null,
    };
  }

  async function extractLitoSrt(file, onProgress) {
    // Read once (LRF-sized files only, <~30MB -- see the .mp4/.mov size gate in decode())
    // and reuse the same buffer for both box-walking and sample extraction.
    const buf = await file.arrayBuffer();
    const dv = new DataView(buf);
    const u8all = new Uint8Array(buf);
    const track = findDjmdTrack(dv, buf.byteLength);
    if (!track) return null;
    const ranges = sampleByteRanges(track);
    if (ranges.length < 2) return null;
    const startMs = (() => {
      const m = (file.name || '').match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (!m) return Date.now();
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    })();
    const frames = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const f = decodeLitoFrame(u8all.subarray(r.offset, r.offset + r.size));
      frames.push(f);
      if (onProgress && (i % 50 === 0)) { onProgress(Math.round(i / ranges.length * 100)); await new Promise(res => setTimeout(res, 0)); }
    }
    // ~30 fps for the LRF track (confirmed on the validation sample) -- used only to space
    // frame timestamps; GPS/altitude values themselves came straight from the track.
    const dtMs = 1000 / 30;
    const pad = (n, w) => String(n).padStart(w, '0');
    const tc = (ms) => { const s = Math.max(0, ms / 1000); return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s % 3600 / 60), 2)}:${pad(Math.floor(s % 60), 2)},${pad(Math.round((s - Math.floor(s)) * 1000), 3)}`; };
    let out = '', wrote = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]; if (!f) continue;
      const t = i * dtMs, nt = (i + 1 < frames.length ? (i + 1) : i + 1) * dtMs;
      const when = new Date(startMs + t);
      const z = (x) => String(x).padStart(2, '0');
      const stamp = `${when.getFullYear()}-${z(when.getMonth() + 1)}-${z(when.getDate())} ${z(when.getHours())}:${z(when.getMinutes())}:${z(when.getSeconds())}.${String(when.getMilliseconds()).padStart(3, '0')}`;
      const rel = f.relAlt != null ? f.relAlt : 0, abs = f.absAlt != null ? f.absAlt : 0;
      wrote++;
      out += `${wrote}\n${tc(t)} --> ${tc(nt)}\n<font size="28">FrameCnt: ${wrote}, DiffTime: 33ms\n${stamp}\n`
        // fnum 1.7 = the Lito X1's REAL fixed aperture — and load-bearing: the dashboard bake's
        // model heuristic reads "wide lens at f>=2.5" as a Matrice 4E, so the old 2.8 placeholder
        // mislabelled Lito flights as M4E and misattributed them (21 double-counted, 28 Jul 2026).
        + `[iso: 100] [shutter: 1/1000.0] [fnum: 1.7] [ev: 0] [color_md: default] [focal_len: 24.00] `
        + `[latitude: ${f.lat.toFixed(6)}] [longitude: ${f.lon.toFixed(6)}] [rel_alt: ${rel.toFixed(3)} abs_alt: ${abs.toFixed(3)}] </font>\n\n`;
    }
    return wrote >= 2 ? out : null;
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
      if (lower.endsWith('.lrf')) {
        // Lito X1 proxy video: same 'djmd' telemetry track as the main .MP4, ~1/8th the
        // size \u2014 this is the file that's actually safe to fully buffer in a tab. The main
        // .MP4 is NOT handled here on purpose (100+ MB, would need the M4E's chunked-scan
        // treatment to be tab-safe, and the LRF already gives identical GPS/altitude).
        const srt = await extractLitoSrt(file, onProgress);
        if (!srt) return { ok: false, kind: 'LITO', name: file.name, error: 'No embedded telemetry found in this .LRF' };
        const res = decodeSRT(srt, file.name);
        if (!res.ok) return Object.assign(res, { kind: 'LITO' });
        return Object.assign(res, { kind: 'LITO', model: 'DJI Lito X1', extractedSrt: srt });
      }
      if (lower.endsWith('.mp4') || lower.endsWith('.mov')) {
        const srt = await extractM4eSrt(file, onProgress);
        if (!srt) {
          return { ok: false, kind: 'M4E', name: file.name,
            error: 'No embedded telemetry in this video \u2014 Matrice 4E videos carry it, but a '
              + 'Lito X1 video does not (drop its .LRF instead, not the .MP4)' };
        }
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
