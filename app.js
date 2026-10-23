(function () {
  "use strict";

  var CFG = window.POLICE_MAP_CONFIG || {};
  var DEFAULT_HQ = CFG.hq || { name: "ภ.จว.เชียงราย", lat: 19.930841, lng: 99.877192 };
  var WARN_KM = CFG.warnDistanceKm || 200;
  var STORE_INPUT = "policemap.input";
  var STORE_HQ = "policemap.hq";

  var $ = function (id) { return document.getElementById(id); };
  var state = { hq: loadHq(), points: [], header: null, sel: [], view: "line" };
  var map = null;

  // ---------- storage (ใช้ได้ก็ใช้ ใช้ไม่ได้ก็ข้าม) ----------
  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function storeDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function loadHq() {
    var raw = storeGet(STORE_HQ);
    if (raw) {
      try {
        var h = JSON.parse(raw);
        if (validLatLng(h.lat, h.lng)) return h;
      } catch (e) { /* ignore */ }
    }
    return { name: DEFAULT_HQ.name, lat: DEFAULT_HQ.lat, lng: DEFAULT_HQ.lng };
  }

  // ---------- คณิตศาสตร์ ----------
  function validLatLng(lat, lng) {
    return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }
  function rad(d) { return d * Math.PI / 180; }
  function haversineKm(a, b) {
    var R = 6371.0088;
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearingDeg(a, b) {
    var y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    var x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  var DIRS = ["เหนือ", "ตะวันออกเฉียงเหนือ", "ตะวันออก", "ตะวันออกเฉียงใต้",
    "ใต้", "ตะวันตกเฉียงใต้", "ตะวันตก", "ตะวันตกเฉียงเหนือ"];
  function dirName(deg) { return DIRS[Math.round(deg / 45) % 8]; }

  // ---------- แปลงข้อความเป็นจุด ----------
  var NUM = /[-+]?\d+(?:\.\d+)?/;
  // หัวคอลัมน์ของไฟล์ Excel แบบมีหัวตาราง (เช่น ไฟล์จุดตรวจสัมพันธ์)
  var H_LAT = /ละติจูด|latitude|^lat$/i;
  var H_LNG = /ลองติจูด|ลองจิจูด|longitude|^lng$|^lon$|^long$/i;
  var H_NAME = [/สถานที่/, /^ชื่อจุด/, /^name$/i];
  var H_PHONE = /โทร|phone|^tel/i;
  var H_DATE = /^วัน|วันที่|^date/i;
  var H_SUMMARY = [/สภ/, /วัน/, /เวลา/];   // แสดงใต้ชื่อจุดในตาราง
  // คอลัมน์ของไฟล์จุดตรวจสัมพันธ์ ใช้ตั้งชื่อคอลัมน์เมื่อวางเฉพาะแถวข้อมูลโดยไม่มีหัวตาราง
  var KNOWN_COLS = ["วัน/เดือน/ปี", "เวลาออกตรวจจุดสัมพันธ์", "สภ.", "ยศ ชื่อ - สกุล ร้อยเวร 20", "ตำแหน่ง ร้อยเวร 20",
    "เบอร์โทรร้อยเวร 20", "สถานที่จุดตรวจสัมพันธ์", "ละติจูด", "ลองติจูด"];

  function findCol(cols, re) {
    for (var c = 0; c < cols.length; c++) if (re.test(cols[c].trim())) return c;
    return -1;
  }

  // ข้อความมีหัวตาราง (คั่นด้วยแท็บ) ที่มีคอลัมน์ละติจูดและลองจิจูดหรือไม่
  function headerOf(line) {
    var cols = line.split("\t");
    var la = findCol(cols, H_LAT), ln = findCol(cols, H_LNG);
    if (la < 0 || ln < 0) return null;
    var nm = -1;
    H_NAME.some(function (re) { nm = findCol(cols, re); return nm >= 0; });
    return { cols: cols.map(function (c) { return c.trim(); }), lat: la, lng: ln, name: nm, date: findCol(cols, H_DATE) };
  }

  // ---------- วันที่ ----------
  var TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  var TH_MON_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

  // อ่านวันที่แบบ ว/ด/ปี (พ.ศ. หรือ ค.ศ., ปี 2 หรือ 4 หลัก), ปี-ด-ว, หรือ "23 ต.ค. 69" คืนค่า { y (ค.ศ.), m, d }
  function parseDay(s) {
    s = String(s || "").trim();
    var y, m, d, r;
    if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?!\d)/.exec(s))) { d = +r[1]; m = +r[2]; y = +r[3]; }
    else if ((r = /^(\d{1,2})\s*([ก-๙.]+)\s*(\d{2,4})(?!\d)/.exec(s))) {
      var mon = r[2].replace(/\./g, "");
      m = 0;
      TH_MON.forEach(function (t, k) { if (t.replace(/\./g, "") === mon) m = k + 1; });
      TH_MON_FULL.forEach(function (t, k) { if (t === mon) m = k + 1; });
      d = +r[1]; y = +r[3];
    } else return null;
    if (y < 100) y = y >= 40 ? 2500 + y : 2000 + y;   // 69 = พ.ศ. 2569, 26 = ค.ศ. 2026
    if (y > 2400) y -= 543;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return { y: y, m: m, d: d };
  }
  function dayKey(o) { return o ? o.y * 10000 + o.m * 100 + o.d : 0; }
  function fmtDay(o) { return o.d + "/" + o.m + "/" + (o.y + 543); }
  function todayObj(offset) {
    var t = new Date(); t.setDate(t.getDate() + (offset || 0));
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }

  // ---------- เตรียมข้อความที่วาง ----------
  // เลขไทยเป็นเลขอารบิก และช่องที่ Excel ใส่เครื่องหมายคำพูดเพราะมีขึ้นบรรทัดใหม่ในช่อง รวมเป็นบรรทัดเดียว
  // พิกัดที่มีอักษรบอกทิศ แปลงเป็นทศนิยม (S และ W ติดลบ):
  // 20.25697N, 100.41035E / N20.25697 E100.41035 / 20°15'25.1"N 100°24'37.3"E (องศา ลิปดา ฟิลิปดา แบบที่ Google Maps คัดลอก)
  function hemi(v, h) { return (/[SW]/i.test(h) ? "-" : "") + v; }
  // คั่นได้เฉพาะช่องว่าง (ไม่ข้ามแท็บหรือบรรทัด คอลัมน์จะได้ไม่เลื่อน) อักษรนำหน้าต้องติดกับตัวเลข
  function normalizeCoords(text) {
    return text
      .replace(/(\d{1,3}) *° *(\d{1,2}(?:\.\d+)?) *['′’] *(?:(\d{1,2}(?:\.\d+)?) *(?:["″”]|'') *)?([NSEW])(?![A-Za-z])/gi,
        function (_, d, m, s, h) { return hemi((+d + m / 60 + (s ? s / 3600 : 0)).toFixed(6), h); })
      .replace(/(^|[^A-Za-z])([NSEW])(\d{1,3}\.\d+)/gi, function (_, pre, h, v) { return pre + hemi(v, h); })
      .replace(/(\d{1,3}\.\d+) ?°? ?([NSEW])(?![A-Za-z0-9])/gi, function (_, v, h) { return hemi(v, h); });
  }

  function normalizeText(text) {
    text = String(text).replace(/[๐-๙]/g, function (c) { return String(c.charCodeAt(0) - 0x0E50); });
    text = normalizeCoords(text);
    if (text.indexOf("\t") < 0 || text.indexOf('"') < 0) return text;
    var out = "", i = 0, n = text.length, start = true;
    while (i < n) {
      var ch = text.charAt(i);
      if (start && ch === '"') {
        i++;
        while (i < n) {
          var q = text.charAt(i);
          if (q === '"') {
            if (text.charAt(i + 1) === '"') { out += '"'; i += 2; continue; }
            i++; break;
          }
          out += q === "\r" || q === "\n" ? " " : q; i++;
        }
        start = false; continue;
      }
      out += ch; start = ch === "\t" || ch === "\n"; i++;
    }
    return out;
  }

  // คู่ละติจูด/ลองจิจูดในแถวที่ไม่มีหัวตาราง: ทศนิยม 2 ค่าติดกันที่เป็นพิกัดได้ (หาจากท้ายแถว)
  var DEC = /^[-+]?\d{1,3}\.\d+$/;
  function findPair(cols) {
    for (var i = cols.length - 2; i >= 0; i--) {
      var a = cols[i].trim(), b = cols[i + 1].trim();
      if (!DEC.test(a) || !DEC.test(b)) continue;
      var x = parseFloat(a), y = parseFloat(b);
      if (validLatLng(x, y) || validLatLng(y, x)) return i;
    }
    return -1;
  }
  var HAS_LETTER = /[ก-๏a-z]/i;

  // ตรวจและสร้างจุดจากค่าละติจูด/ลองจิจูดที่อ่านได้ (ใช้ร่วมกันทั้งแบบมีหัวตารางและแบบบรรทัดธรรมดา)
  function makePoint(latS, lngS, name, lineNo, msgs, points) {
    var lat = parseFloat(latS), lng = parseFloat(lngS);
    // สลับให้อัตโนมัติถ้ากรอกกลับด้าน (ประเทศไทย lat 5-21, lng 97-106)
    if ((Math.abs(lat) > 90 && Math.abs(lng) <= 90) ||
        (lat >= 97 && lat <= 106 && lng >= 5 && lng <= 21)) {
      var t = lat; lat = lng; lng = t;
      msgs.push({ type: "warn", text: "บรรทัด " + lineNo + ": สลับละติจูด/ลองจิจูดให้อัตโนมัติ" });
    }
    if (!validLatLng(lat, lng)) {
      msgs.push({ type: "err", text: "บรรทัด " + lineNo + ": พิกัดอยู่นอกช่วงที่ถูกต้อง" });
      return null;
    }
    var p = { lat: lat, lng: lng, name: name || ("จุดที่ " + (points.length + 1)), line: lineNo, info: [] };
    points.push(p);
    return p;
  }

  // opts.day = dayKey ของวันที่ต้องการ (0 = ทุกวัน) แถวที่มีวันที่ตรงกันเท่านั้นที่ปักหมุด แถวที่ไม่มีวันที่แสดงเสมอ
  function parseInput(text, opts) {
    opts = opts || {};
    var points = [], msgs = [], head = null, headLine = null;
    var days = {}, skipped = 0, lastDate = "";
    var lines = normalizeText(text).split(/\r?\n/);

    // คืน true ถ้าแถวนี้ต้องข้ามเพราะไม่ใช่วันที่เลือก
    function offDay(dateS, lineNo) {
      if (dateS) lastDate = dateS; else dateS = lastDate;   // ช่องวันที่ที่ผสานเซลล์ไว้ ใช้วันที่ของแถวก่อนหน้า
      if (!dateS) return false;
      var d = parseDay(dateS);
      if (!d) {
        if (opts.day) { msgs.push({ type: "warn", text: "บรรทัด " + lineNo + ": อ่านวันที่ \"" + dateS + "\" ไม่ได้ ข้ามแถวนี้" }); return true; }
        return false;
      }
      var k = dayKey(d);
      days[k] = (days[k] || 0) + 1;
      if (opts.day && k !== opts.day) { skipped++; return true; }
      return false;
    }

    lines.forEach(function (line, idx) {
      var lineNo = idx + 1;
      var s = line.replace(/[°]/g, "").trim();
      if (!s || s.charAt(0) === "#") return;

      // แบบมีหัวตาราง: บรรทัดหัวคอลัมน์อยู่ก่อนข้อมูลแถวแรก (ข้ามแถวชื่อเรื่องด้านบนได้)
      if (!head && points.length === 0) {
        var h = headerOf(line);
        if (h) { head = h; headLine = line; return; }
      }
      if (head) {
        var cols = line.split("\t").map(function (c) { return c.trim(); });
        if (head.date >= 0 && offDay(cols[head.date], lineNo)) return;
        var la = (cols[head.lat] || "").replace(/[°\s]/g, ""), lo = (cols[head.lng] || "").replace(/[°\s]/g, "");
        // ใส่ "lat, lng" ไว้ในช่องเดียว (ช่องละติจูด หรือช่องลองจิจูดเมื่อช่องละติจูดว่าง)
        var PAIR = /^([-+]?\d+\.\d+),([-+]?\d+\.\d+)$/;
        var both = PAIR.exec(la) || (!la ? PAIR.exec(lo) : null);
        if (both) { la = both[1]; lo = both[2]; }
        if (!la && !lo) {
          msgs.push({ type: "warn", text: "บรรทัด " + lineNo + ": ไม่มีพิกัด ข้ามแถวนี้" + (cols[head.name] ? " (" + cols[head.name] + ")" : "") });
          return;
        }
        if (!isNum(la) || !isNum(lo)) {
          msgs.push({ type: "err", text: "บรรทัด " + lineNo + ": อ่านพิกัดไม่ได้ \"" + la + ", " + lo + "\"" });
          return;
        }
        var hp = makePoint(la, lo, head.name >= 0 ? cols[head.name] : "", lineNo, msgs, points);
        if (!hp) return;
        hp.raw = line;
        head.cols.forEach(function (label, c) {
          var v = cols[c] || (c === head.date ? lastDate : "");
          if (c === head.lat || c === head.lng || c === head.name || !v) return;
          hp.info.push({ k: label, v: v });
        });
        return;
      }

      // แบบเดิม: ละติจูด, ลองจิจูด, ชื่อ (2 ค่าแรกเป็นตัวเลข)
      var parts = s.split(/\t|,|;/).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length < 2 || !isNum(parts[0]) || !isNum(parts[1])) {
        var ws = s.split(/\s+/);
        if (ws.length >= 2 && isNum(ws[0]) && isNum(ws[1])) parts = [ws[0], ws[1], ws.slice(2).join(" ")];
      }
      if (parts.length >= 2 && isNum(parts[0]) && isNum(parts[1])) {
        var name = parts.slice(2).join(" ").replace(/^"|"$/g, "").trim();
        var p = makePoint(parts[0], parts[1], name, lineNo, msgs, points);
        if (p) p.raw = line;
        return;
      }

      // แถวที่คัดลอกจาก Excel โดยไม่มีหัวตาราง (คั่นแท็บ) หรือข้อความทั่วไป: หาคู่พิกัดในแถว
      var tab = line.indexOf("\t") >= 0;
      var cells = tab ? line.split("\t").map(function (c) { return c.trim(); }) : s.split(/[\s,]+/);
      var at = findPair(cells);
      if (at < 0) {
        // แถวชื่อเรื่องก่อนข้อมูล (ไม่มีตัวเลขพิกัด) ข้ามเงียบ ๆ
        if (points.length === 0 && !/\d+\.\d+/.test(s)) return;
        msgs.push({ type: "err", text: "บรรทัด " + lineNo + ": อ่านพิกัดไม่ได้ \"" + line.trim().slice(0, 80) + "\"" });
        return;
      }
      var known = tab && cells.length >= KNOWN_COLS.length && at === 7;
      var dateCol = known ? 0 : -1;
      if (!known) cells.some(function (c, k) { if (k !== at && k !== at + 1 && parseDay(c)) { dateCol = k; return true; } return false; });
      if (dateCol >= 0 && offDay(cells[dateCol], lineNo)) return;
      var p2;
      if (tab) {
        var nameCol = known ? 6 : -1;
        if (nameCol < 0) for (var k = at - 1; k >= 0; k--) if (k !== dateCol && HAS_LETTER.test(cells[k])) { nameCol = k; break; }
        p2 = makePoint(cells[at], cells[at + 1], nameCol >= 0 ? cells[nameCol] : "", lineNo, msgs, points);
        if (!p2) return;
        cells.forEach(function (v, c) {
          if (c === at || c === at + 1 || c === nameCol) return;
          if (c === dateCol && !v) v = lastDate;
          if (v) p2.info.push({ k: known ? KNOWN_COLS[c] || "คอลัมน์ " + (c + 1) : "คอลัมน์ " + (c + 1), v: v });
        });
      } else {
        var rest = s.replace(cells[at], " ").replace(cells[at + 1], " ").replace(/[\s,]+/g, " ").trim();
        p2 = makePoint(cells[at], cells[at + 1], rest, lineNo, msgs, points);
        if (!p2) return;
      }
      p2.raw = line;
    });
    return { points: points, msgs: msgs, header: head ? headLine : null, days: days, skipped: skipped };
  }
  function isNum(s) { return typeof s === "string" && new RegExp("^" + NUM.source + "$").test(s.trim()); }

  // ---------- นำเข้าไฟล์ Excel/CSV (อ่านในเบราว์เซอร์ ไม่อัปโหลดไปที่ใด) ----------
  var XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return loadXlsx.p || (loadXlsx.p = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = XLSX_URL;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { loadXlsx.p = null; rej(new Error("โหลดตัวอ่านไฟล์ Excel ไม่สำเร็จ (ต้องต่ออินเทอร์เน็ต)")); };
      document.head.appendChild(s);
    }));
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // ค่าในช่องเป็นข้อความ: วันที่ = ว/ด/ปี พ.ศ., เวลา = ชม:นาที, พิกัดเก็บทศนิยมครบ, เบอร์โทรเติม 0 ที่ Excel ตัดทิ้ง
  function cellText(X, cell, label) {
    if (!cell || cell.v == null) return "";
    var v = cell.v;
    if (cell.t === "n" && cell.z && X.SSF.is_date(cell.z)) {
      var d = X.SSF.parse_date_code(v);
      var time = pad2(d.H) + ":" + pad2(d.M);
      if (v < 1) return time;
      var y = d.y < 2400 ? d.y + 543 : d.y;
      var date = d.d + "/" + d.m + "/" + y;
      return v % 1 ? date + " " + time : date;
    }
    if (cell.t === "n") {
      if (H_PHONE.test(label) && /^[1-9]\d{8}$/.test(String(v))) return "0" + v;
      if (H_LAT.test(label) || H_LNG.test(label)) return String(v);
      return cell.w != null ? String(cell.w) : String(v);
    }
    return String(cell.w != null && cell.t !== "s" ? cell.w : v);
  }

  // อ่านทุกแผ่นงานที่มีหัวคอลัมน์ละติจูดและลองจิจูด รวมเป็นข้อความคั่นแท็บชุดเดียว (หัวตาราง + แถวข้อมูล)
  // แผ่นงานถัดไปจับคอลัมน์ตามชื่อหัวคอลัมน์ของแผ่นแรก เซลล์ที่ผสานไว้ (เช่น วันที่) ใส่ค่าให้ทุกแถวในช่วงนั้น
  function sheetToTsv(X, wb) {
    var clean = function (s) { return String(s).replace(/[\t\r\n]+/g, " ").trim(); };
    var master = null, out = [], rows = 0, sheets = [];
    wb.SheetNames.forEach(function (sn) {
      var ws = wb.Sheets[sn];
      if (!ws || !ws["!ref"]) return;
      var rg = X.utils.decode_range(ws["!ref"]);
      var merged = {};
      (ws["!merges"] || []).forEach(function (m) {
        var top = ws[X.utils.encode_cell(m.s)];
        for (var r = m.s.r; r <= m.e.r; r++) for (var c = m.s.c; c <= m.e.c; c++) merged[r + "," + c] = top;
      });
      var get = function (r, c) { return ws[X.utils.encode_cell({ r: r, c: c })] || merged[r + "," + c]; };
      for (var r = rg.s.r; r <= Math.min(rg.e.r, rg.s.r + 30); r++) {
        var labels = [];
        for (var c = rg.s.c; c <= rg.e.c; c++) labels.push(clean(cellText(X, get(r, c), "")));
        if (findCol(labels, H_LAT) < 0 || findCol(labels, H_LNG) < 0) continue;
        while (labels.length && !labels[labels.length - 1]) labels.pop();
        if (!master) { master = labels; out.push(labels.join("\t")); }
        // ตำแหน่งคอลัมน์ในแผ่นนี้ของหัวคอลัมน์แต่ละตัวในแผ่นแรก
        var map = master.map(function (lab) { var k = labels.indexOf(lab); return k; });
        var n = 0;
        for (var rr = r + 1; rr <= rg.e.r; rr++) {
          var vals = master.map(function (lab, k) { return map[k] < 0 ? "" : clean(cellText(X, get(rr, rg.s.c + map[k]), lab)); });
          if (!vals.some(Boolean)) continue;
          out.push(vals.join("\t")); n++;
        }
        rows += n; sheets.push(sn);
        return;
      }
    });
    return master ? { tsv: out.join("\n"), sheets: sheets, rows: rows } : null;
  }

  function importFile(f) {
    var isText = /\.(csv|txt)$/i.test(f.name);
    var read = new Promise(function (res, rej) {
      var rd = new FileReader();
      rd.onload = function () { res(rd.result); };
      rd.onerror = function () { rej(new Error("อ่านไฟล์ไม่ได้")); };
      if (isText) rd.readAsText(f, "utf-8"); else rd.readAsArrayBuffer(f);
    });
    return read.then(function (data) {
      var text = isText ? String(data).replace(/^﻿/, "") : null;
      // CSV แบบ ละติจูด, ลองจิจูด, ชื่อ ที่ไม่มีหัวตาราง ใช้ตัวอ่านเดิมได้เลย ไม่ต้องโหลด SheetJS
      if (isText && !(H_LAT.test(text.split(/\r?\n/)[0]) && H_LNG.test(text.split(/\r?\n/)[0]))) return { tsv: text };
      return loadXlsx().then(function (X) {
        var wb = isText ? X.read(text, { type: "string", raw: true }) : X.read(data, { type: "array", cellNF: true });
        var got = sheetToTsv(X, wb);
        if (!got) throw new Error("ไม่พบคอลัมน์ \"ละติจูด\" และ \"ลองติจูด\" ในไฟล์ " + f.name);
        return got;
      });
    });
  }

  // ---------- ลิงก์ Google Maps (ไม่ต้องใช้ key) ----------
  function ll(p) { return p.lat.toFixed(6) + "," + p.lng.toFixed(6); }
  function gmPinUrl(p) { return "https://www.google.com/maps/search/?api=1&query=" + ll(p); }
  // นำทางไปจุดที่เลือกตรวจ: เริ่มจากตำแหน่งปัจจุบัน แวะตามลำดับที่เลือก จบที่จุดสุดท้ายที่เลือก
  function gmVisitUrl(pts) {
    var last = pts[pts.length - 1];
    return gmDirFromHereUrl(last) + (pts.length > 1 ? "&waypoints=" + encodeURIComponent(pts.slice(0, -1).map(ll).join("|")) : "");
  }

  // ---------- เลือกจุดที่จะไปตรวจ ----------
  // state.sel = index ของจุดตามลำดับที่ผู้ใช้แตะเลือก (= ลำดับที่จะไป) เก็บไว้ในเครื่อง กลับมาจากแอปนำทางแล้วยังอยู่
  var MAX_VISIT = 10;   // ลิงก์ Google Maps: จุดแวะ 9 + ปลายทาง 1
  var STORE_SEL = "policemap.sel";
  function selSig() { return state.points.map(function (p) { return ll(p) + p.name; }).join("|"); }
  function saveSel() { storeSet(STORE_SEL, JSON.stringify({ sig: selSig(), sel: state.sel })); }
  function restoreSel() {
    state.sel = [];
    try {
      var s = JSON.parse(storeGet(STORE_SEL) || "null");
      if (s && s.sig === selSig()) state.sel = s.sel.filter(function (i) { return i >= 0 && i < state.points.length; });
    } catch (e) { /* ignore */ }
  }
  function selNo(i) { return state.sel.indexOf(i) + 1; }
  function toggleSel(i) {
    var k = state.sel.indexOf(i);
    if (k >= 0) state.sel.splice(k, 1);
    else if (state.sel.length >= MAX_VISIT) {
      showMsgs([{ type: "warn", text: "เลือกได้ไม่เกิน " + MAX_VISIT + " จุดต่อการนำทาง 1 ครั้ง (ข้อจำกัดของ Google Maps)" }]);
      renderTable(); return;
    } else state.sel.push(i);
    saveSel();
    renderTable();
    if (map) map.select(state.sel);
    scheduleRoutes();
  }

  // ---------- ระยะทางถนนและเวลา ของจุดที่เลือกตรวจ (OSRM) ----------
  // วนตรวจ = ภ.จว. > จุดที่เลือกตามลำดับที่แตะ > กลับ ภ.จว. (ผลนี้ใช้แสดงระยะในแถบจุดที่เลือกด้วย)
  // ไปแต่ละจุด = ภ.จว. > จุดที่เลือกแต่ละจุด  พิกัดเฉพาะจุดที่เลือกถูกส่งไปเซิร์ฟเวอร์ OSRM เพื่อคำนวณ
  var OSRM_URL = "https://router.project-osrm.org";   // เปลี่ยนเป็นเซิร์ฟเวอร์ OSRM ของหน่วยงานได้
  var OSRM_GAP_MS = 1100;                              // นโยบายเซิร์ฟเวอร์สาธิต OSRM: ไม่เกิน 1 ครั้งต่อวินาที
  var VIEW_COLOR = { star: "#0b57d0", loop: "#7b1fa2" };
  var routeCache = {}, osrmQueue = Promise.resolve(), routeJob = 0, routeTimer = null;
  var routeState = { busy: false, err: "" };

  function coordKey(coords) { return coords.map(ll).join(";"); }

  // คืนค่า { km, min, legs:[{km,min}], path:[[lat,lng],...] } คำขอเข้าคิวเว้นระยะตามนโยบายเซิร์ฟเวอร์
  function osrmRoute(coords) {
    var key = coordKey(coords);
    if (routeCache[key]) return Promise.resolve(routeCache[key]);
    var q = coords.map(function (c) { return c.lng.toFixed(6) + "," + c.lat.toFixed(6); }).join(";");
    var p = osrmQueue.then(function () {
      if (routeCache[key]) return routeCache[key];
      return fetch(OSRM_URL + "/route/v1/driving/" + q + "?overview=full&geometries=geojson&steps=false")
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) {
          if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error(j.message || j.code || "NoRoute");
          var rt = j.routes[0];
          routeCache[key] = {
            km: rt.distance / 1000, min: rt.duration / 60,
            legs: rt.legs.map(function (l) { return { km: l.distance / 1000, min: l.duration / 60 }; }),
            path: rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; })
          };
          return routeCache[key];
        });
    });
    osrmQueue = p.catch(function () {}).then(function () { return new Promise(function (r) { setTimeout(r, OSRM_GAP_MS); }); });
    return p;
  }

  // ---------- ระยะทางถนนและเวลาจาก ภ.จว. ของทุกจุดในตาราง (OSRM table: 1 คำขอได้ทุกจุด) ----------
  var ROAD_CHUNK = 90;   // จุดต่อคำขอ (เซิร์ฟเวอร์สาธิตรับไม่เกิน 100 พิกัด)
  var roadCache = {}, roadJob = 0, roadState = { busy: false, err: "" };
  // { km, min } หรือ { none: true } เมื่อไม่มีเส้นทางถนนถึงจุดนั้น
  function roadOf(p) { return roadCache[coordKey([state.hq, p])] || null; }

  function scheduleRoad() {
    var job = ++roadJob, hq = state.hq;
    var todo = state.points.filter(function (p) { return !roadOf(p); });
    roadState.err = "";
    roadState.busy = todo.length > 0;
    afterRoute();
    if (!todo.length) return;
    var chunks = [];
    for (var c = 0; c < todo.length; c += ROAD_CHUNK) chunks.push(todo.slice(c, c + ROAD_CHUNK));
    chunks.reduce(function (chain, ch) {
      return chain.then(function () {
        if (job !== roadJob) return;
        var q = [hq].concat(ch).map(function (x) { return x.lng.toFixed(6) + "," + x.lat.toFixed(6); }).join(";");
        var p = osrmQueue.then(function () {
          return fetch(OSRM_URL + "/table/v1/driving/" + q + "?sources=0&annotations=duration,distance")
            .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
        });
        osrmQueue = p.catch(function () {}).then(function () { return new Promise(function (r) { setTimeout(r, OSRM_GAP_MS); }); });
        return p.then(function (j) {
          if (j.code !== "Ok" || !j.distances) throw new Error(j.message || j.code || "NoTable");
          ch.forEach(function (pt, k) {
            var d = j.distances[0][k + 1], t = j.durations[0][k + 1];
            roadCache[coordKey([hq, pt])] = d == null || t == null ? { none: true } : { km: d / 1000, min: t / 60 };
          });
          if (job === roadJob) afterRoute();
        });
      });
    }, Promise.resolve()).catch(function (e) {
      if (job === roadJob) roadState.err = "คำนวณระยะทางถนนไม่สำเร็จ (" + (e && e.message ? e.message : e) + ") จึงแสดงระยะเส้นตรง";
    }).then(function () {
      if (job === roadJob) { roadState.busy = false; afterRoute(); }
    });
  }

  function fmtMin(min) {
    var m = Math.round(min);
    if (m < 60) return m + " นาที";
    return Math.floor(m / 60) + " ชม. " + (m % 60) + " นาที";
  }
  function fmtLeg(x) { return x.km.toFixed(1) + " กม. " + fmtMin(x.min); }
  function selPts() { return state.sel.map(function (i) { return state.points[i]; }); }
  // ผลของชุดที่เลือกปัจจุบัน (ถ้าเปลี่ยนการเลือกหรือ ภ.จว. จะยังไม่มีผลจนกว่าคำนวณใหม่เสร็จ)
  function loopRes() { return state.sel.length ? routeCache[coordKey([state.hq].concat(selPts(), [state.hq]))] || null : null; }
  function starRes(i) { return routeCache[coordKey([state.hq, state.points[i]])] || null; }
  // ระยะถนนของจุดที่ i ตามมุมมองปัจจุบัน
  function legFor(i) {
    var k = state.sel.indexOf(i);
    if (k < 0) return null;
    if (state.view === "star") return starRes(i);
    if (state.view === "loop") { var r = loopRes(); return r ? r.legs[k] : null; }
    return null;
  }

  function scheduleRoutes() {
    clearTimeout(routeTimer);
    var job = ++routeJob;
    routeState.err = "";
    var need = state.sel.length ? [[state.hq].concat(selPts(), [state.hq])] : [];
    if (state.view === "star") selPts().forEach(function (p) { need.push([state.hq, p]); });
    // คำนวณไว้แล้วทั้งหมด (เช่น สลับมุมมองกลับมา) แสดงผลทันที ไม่ต้องรอ
    routeState.busy = need.some(function (c) { return !routeCache[coordKey(c)]; });
    afterRoute();
    if (!routeState.busy) return;
    // รอให้แตะเลือกจุดเสร็จก่อน ไม่ส่งคำขอทุกครั้งที่แตะ
    routeTimer = setTimeout(function () {
      var hq = state.hq, pts = selPts();
      var tasks = [function () { return osrmRoute([hq].concat(pts, [hq])); }];
      if (state.view === "star") pts.forEach(function (p) { tasks.push(function () { return osrmRoute([hq, p]); }); });
      tasks.reduce(function (chain, t) {
        return chain.then(function () {
          if (job !== routeJob) return;
          return t().then(function () { if (job === routeJob) afterRoute(); });
        });
      }, Promise.resolve()).catch(function (e) {
        if (job === routeJob) routeState.err = "คำนวณระยะทางถนนไม่สำเร็จ (" + (e && e.message ? e.message : e) + ") ตรวจการเชื่อมต่ออินเทอร์เน็ต แล้วเลือกจุดใหม่อีกครั้ง";
      }).then(function () {
        if (job === routeJob) { routeState.busy = false; afterRoute(); }
      });
    }, 500);
  }

  function afterRoute() {
    renderTable();
    renderView();
    if (map) map.render(state.hq, state.points, routeLines());
  }

  // เส้นบนแผนที่ตามมุมมอง: null = เส้นตรงประจาก ภ.จว. ไปทุกจุด
  function routeLines() {
    if (state.view === "line") return null;
    var lines = [];
    if (state.view === "loop") {
      var r = loopRes();
      if (r) lines.push({ path: r.path, color: VIEW_COLOR.loop, label: "วนตรวจ " + state.sel.length + " จุด รวม " + fmtLeg(r) });
    } else {
      state.sel.forEach(function (i, k) {
        var s = starRes(i);
        if (s) lines.push({ path: s.path, color: VIEW_COLOR.star, label: (k + 1) + ") " + state.points[i].name + ": " + fmtLeg(s) });
      });
    }
    return lines;
  }

  var VIEW_NOTE = "ระยะทางถนนคำนวณโดย OSRM (ส่งพิกัดเฉพาะจุดที่เลือกไปคำนวณ) เวลาเป็นค่าประมาณสำหรับรถยนต์ ไม่รวมสภาพจราจร";

  function renderView() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-view") === state.view ? "true" : "false");
    });
    var el = $("viewStatus"), v = state.view, n = state.sel.length, html = "";
    if (v === "line") {
      html = "แผนที่แสดงเส้นตรงจาก ภ.จว. ไปทุกจุด ระยะในตารางเป็นระยะทางถนนและเวลาจาก ภ.จว." +
        (roadState.busy ? '<br><span class="busy">กำลังคำนวณระยะทางถนน</span>' : "") +
        (roadState.err ? '<br><span class="err">' + esc(roadState.err) + "</span>" : "") +
        (state.points.length ? '<span class="note">ระยะทางถนนคำนวณโดย OSRM (ส่งพิกัดของจุดในรายการไปคำนวณ) เวลาไม่รวมสภาพจราจร</span>' : "");
    }
    else if (!n) html = "เลือกจุดตรวจก่อน (ติ๊กช่อง \"ตรวจ\" ในรายการ หรือแตะหมุดแล้วกด \"เลือกตรวจจุดนี้\")";
    else if (v === "loop") {
      var r = loopRes();
      html = r
        ? "<b>วนตรวจ " + n + " จุด รวม " + fmtLeg(r) + "</b> (ภ.จว. > " +
          state.sel.map(function (i, k) { return (k + 1) + ") " + esc(state.points[i].name); }).join(" > ") + " > กลับ ภ.จว.)"
        : "";
    } else {
      html = "<b>จาก ภ.จว. ไปแต่ละจุดที่เลือก (ทางถนน)</b><br>" + state.sel.map(function (i, k) {
        var s = starRes(i);
        return (k + 1) + ") " + esc(state.points[i].name) + ": " + (s ? fmtLeg(s) : "...");
      }).join("<br>");
    }
    if (v !== "line" && n) {
      if (routeState.busy) html += (html ? "<br>" : "") + '<span class="busy">กำลังคำนวณระยะทางถนน</span>';
      if (routeState.err) html += (html ? "<br>" : "") + '<span class="err">' + esc(routeState.err) + "</span>";
      html += '<span class="note">' + VIEW_NOTE + "</span>";
    }
    el.innerHTML = html;
  }

  // หมุดวาดใหม่เฉพาะเมื่อจุดหรือ ภ.จว. เปลี่ยน ป๊อปอัปที่เปิดอยู่จึงไม่ปิดเองเมื่อเลือกจุดตรวจ
  function pointsSig(hq, pts) { return [hq.name, ll(hq)].concat(pts.map(function (p) { return ll(p) + p.name; })).join("|"); }

  // ---------- Map adapter: Leaflet ----------
  function LeafletAdapter(el) {
    var m = L.map(el, { zoomControl: true }).setView([state.hq.lat, state.hq.lng], 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
    }).addTo(m);
    var lineLayer = L.layerGroup().addTo(m);
    // รวมหมุดที่อยู่ใกล้กันเป็นกลุ่มพร้อมจำนวน ซูมเข้าแล้วแยกเป็นหมุดเดี่ยว (หมุด ภ.จว. ไม่รวมกลุ่ม)
    var pinLayer = L.markerClusterGroup ? L.markerClusterGroup({
      maxClusterRadius: 40, showCoverageOnHover: false, disableClusteringAtZoom: 14, spiderfyOnMaxZoom: true,
      iconCreateFunction: function (c) {
        var n = c.getChildCount();
        return L.divIcon({ className: "", iconSize: [36, 36], html: '<div class="cluster"><span>' + n + "</span></div>" });
      }
    }).addTo(m) : L.layerGroup().addTo(m);
    var hqLayer = L.layerGroup().addTo(m);
    var markers = [], sig = null;
    var popupOpts = { maxWidth: 260, minWidth: 200, autoPanPadding: [16, 16] };

    function icon(label, isHq, isSel) {
      return L.divIcon({
        className: "", iconSize: isHq ? [34, 34] : [28, 28], iconAnchor: isHq ? [17, 34] : [14, 28],
        popupAnchor: [0, -28],
        html: '<div class="pin' + (isHq ? " hq" : "") + (isSel ? " sel" : "") + '"><span>' + esc(label) + "</span></div>"
      });
    }
    function applySel(sel) {
      markers.forEach(function (mk, i) {
        var on = sel.indexOf(i) >= 0;
        if (mk.selOn === on) return;
        mk.selOn = on;
        // setIcon ผูกป๊อปอัปใหม่ทำให้ป๊อปอัปปิด เปิดกลับให้เห็นว่าเลือกแล้ว
        var wasOpen = mk.isPopupOpen && mk.isPopupOpen();
        mk.setIcon(icon(String(i + 1), false, on));
        mk.setZIndexOffset(on ? 500 : 0);
        if (wasOpen) mk.openPopup();
      });
      markers.forEach(function (mk) { if (mk.isPopupOpen()) mk.getPopup().setContent(mk.getPopup().options.build()); });
    }
    return {
      name: "OpenStreetMap",
      select: applySel,
      render: function (hq, pts, lines) {
        lineLayer.clearLayers();
        if (lines) {
          lines.forEach(function (ln) {
            L.polyline(ln.path, { color: ln.color, weight: 4, opacity: .8 })
              .bindTooltip(ln.label, { className: "dist", sticky: true }).addTo(lineLayer);
          });
        } else {
          pts.forEach(function (p) {
            L.polyline([[hq.lat, hq.lng], [p.lat, p.lng]], { color: "#0b57d0", weight: 2, opacity: .55, dashArray: "6 6" })
              .bindTooltip(p.km.toFixed(1) + " กม. (เส้นตรง)", { className: "dist", sticky: true }).addTo(lineLayer);
          });
        }
        var nsig = pointsSig(hq, pts);
        if (nsig === sig) {
          // อัปเดตเนื้อหาป๊อปอัปที่เปิดอยู่ (เช่น ระยะถนนเพิ่งได้มา)
          markers.forEach(function (mk) { if (mk.isPopupOpen()) mk.getPopup().setContent(mk.getPopup().options.build()); });
          return;
        }
        sig = nsig;
        pinLayer.clearLayers(); hqLayer.clearLayers(); markers = [];
        pts.forEach(function (p, i) {
          var build = function () { return popupHtml(p, i, state.hq); };
          var mk = L.marker([p.lat, p.lng], { icon: icon(String(i + 1), false) })
            .bindPopup(build, L.extend({ build: build }, popupOpts));
          markers.push(mk);
        });
        applySel(state.sel);
        if (pinLayer.addLayers) pinLayer.addLayers(markers); else markers.forEach(function (mk) { pinLayer.addLayer(mk); });
        var hqBuild = function () { return hqPopupHtml(state.hq); };
        L.marker([hq.lat, hq.lng], { icon: icon("ภ", true), zIndexOffset: 1000 })
          .bindPopup(hqBuild, L.extend({ build: hqBuild }, popupOpts)).addTo(hqLayer);
      },
      fit: function (hq, pts) {
        var all = [[hq.lat, hq.lng]].concat(pts.map(function (p) { return [p.lat, p.lng]; }));
        if (all.length === 1) m.setView(all[0], 12);
        else m.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 15 });
      },
      focus: function (i) {
        var mk = markers[i]; if (!mk) return;
        // ไม่ใช้แอนิเมชันตอนเลื่อน ให้ autoPan ของป๊อปอัปขยับแผนที่จนเห็นป๊อปอัปครบ
        m.setView(mk.getLatLng(), Math.max(m.getZoom(), 14), { animate: false });
        if (pinLayer.zoomToShowLayer) pinLayer.zoomToShowLayer(mk, function () { mk.openPopup(); });
        else mk.openPopup();
      },
      resize: function () { m.invalidateSize(); }
    };
  }

  // ---------- Map adapter: Google Maps ----------
  function GoogleAdapter(el) {
    var g = google.maps;
    var m = new g.Map(el, {
      center: { lat: state.hq.lat, lng: state.hq.lng }, zoom: 9,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: true, gestureHandling: "greedy"
    });
    var info = new g.InfoWindow({ maxWidth: 260 });
    var lines = [], pins = [], markers = [], sig = null, openBuild = null;
    var clusterer = window.markerClusterer ? new markerClusterer.MarkerClusterer({ map: m, markers: [] }) : null;
    info.addListener("closeclick", function () { openBuild = null; });

    function open(build, anchor) { openBuild = build; info.setContent(build()); info.open({ map: m, anchor: anchor }); }
    function applySel(sel) {
      markers.forEach(function (mk, i) {
        var on = sel.indexOf(i) >= 0;
        mk.setIcon(on ? { path: g.SymbolPath.CIRCLE, scale: 13, fillColor: "#188038", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 } : null);
        mk.setZIndex(on ? 500 : null);
      });
      if (openBuild) info.setContent(openBuild());
    }
    return {
      name: "Google Maps",
      raw: m,
      select: applySel,
      render: function (hq, pts, routes) {
        lines.forEach(function (o) { o.setMap(null); }); lines = [];
        if (routes) {
          routes.forEach(function (ln) {
            var pl = new g.Polyline({
              map: m, path: ln.path.map(function (c) { return { lat: c[0], lng: c[1] }; }),
              strokeColor: ln.color, strokeOpacity: .8, strokeWeight: 4
            });
            pl.addListener("click", function (e) { openBuild = null; info.setContent(esc(ln.label)); info.setPosition(e.latLng); info.open({ map: m }); });
            lines.push(pl);
          });
        } else {
          pts.forEach(function (p) {
            lines.push(new g.Polyline({
              map: m, path: [{ lat: hq.lat, lng: hq.lng }, { lat: p.lat, lng: p.lng }],
              strokeOpacity: 0, icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: .6, strokeColor: "#0b57d0", scale: 2 }, offset: "0", repeat: "12px" }]
            }));
          });
        }
        var nsig = pointsSig(hq, pts);
        if (nsig === sig) { if (openBuild) info.setContent(openBuild()); return; }
        sig = nsig;
        pins.forEach(function (o) { o.setMap(null); }); pins = []; markers = [];
        if (clusterer) clusterer.clearMarkers();
        pts.forEach(function (p, i) {
          var mk = new g.Marker({ map: clusterer ? null : m, position: { lat: p.lat, lng: p.lng }, label: { text: String(i + 1), color: "#fff", fontWeight: "700" }, title: p.name });
          mk.addListener("click", function () { open(function () { return popupHtml(p, i, state.hq); }, mk); });
          markers.push(mk);
          if (!clusterer) pins.push(mk);
        });
        applySel(state.sel);
        if (clusterer) clusterer.addMarkers(markers);
        var hqMk = new g.Marker({
          map: m, position: { lat: hq.lat, lng: hq.lng }, title: hq.name, zIndex: 1000,
          icon: { path: g.SymbolPath.CIRCLE, scale: 11, fillColor: "#c62828", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
          label: { text: "ภ", color: "#fff", fontWeight: "700" }
        });
        hqMk.addListener("click", function () { open(function () { return hqPopupHtml(state.hq); }, hqMk); });
        pins.push(hqMk);
      },
      fit: function (hq, pts) {
        if (!pts.length) { m.setCenter({ lat: hq.lat, lng: hq.lng }); m.setZoom(12); return; }
        var b = new g.LatLngBounds();
        b.extend({ lat: hq.lat, lng: hq.lng });
        pts.forEach(function (p) { b.extend({ lat: p.lat, lng: p.lng }); });
        m.fitBounds(b, 40);
      },
      focus: function (i) {
        var mk = markers[i]; if (!mk) return;
        // ซูมให้พ้นระยะรวมกลุ่มก่อน แล้วค่อยเปิดป๊อปอัปเมื่อแผนที่นิ่ง
        m.panTo(mk.getPosition()); if (m.getZoom() < 16) m.setZoom(16);
        g.event.addListenerOnce(m, "idle", function () { g.event.trigger(mk, "click"); });
      },
      resize: function () { /* Google จัดการเอง */ }
    };
  }

  function loadGoogle(key) {
    return new Promise(function (resolve, reject) {
      var done = false;
      window.__policeMapGoogleReady = function () { done = true; resolve(); };
      window.gm_authFailure = function () { reject(new Error("auth")); }; // key ผิด/ไม่ได้อนุญาตโดเมนนี้
      var s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
        "&callback=__policeMapGoogleReady&language=th&region=TH&v=weekly";
      s.async = true;
      s.onerror = function () { reject(new Error("load")); };
      document.head.appendChild(s);
      setTimeout(function () { if (!done) reject(new Error("timeout")); }, 10000);
    });
  }

  function useLeaflet(reason) {
    $("map").innerHTML = "";
    map = LeafletAdapter($("map"));
    setBadge("OpenStreetMap");
    if (reason) showMsgs([{ type: "warn", text: reason }], true);
    refresh(true);
  }

  function initMap() {
    var key = (CFG.googleMapsApiKey || "").trim();
    if (!key) { useLeaflet(); return; }
    var BAD_KEY = "Google Maps API key ใช้ไม่ได้ (ตรวจ key, การจำกัดโดเมน และการเปิด Maps JavaScript API) จึงสลับเป็น OpenStreetMap";
    loadGoogle(key).then(function () {
      return new Promise(function (res) {
        var s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer@2.5.3/dist/index.min.js";
        s.onload = res; s.onerror = res; // ถ้าโหลดไม่ได้ก็ใช้หมุดเดี่ยวตามเดิม
        document.head.appendChild(s);
      });
    }).then(function () {
      var ready = false, fellBack = false;
      function fallback() { if (!ready && !fellBack) { fellBack = true; useLeaflet(BAD_KEY); } }
      // auth ล้มเหลวอาจมาหลังโหลดเสร็จ
      window.gm_authFailure = function () { ready = false; fallback(); };
      map = GoogleAdapter($("map"));
      setBadge("Google Maps");
      // key ผิดบางกรณี Google ไม่เรียก gm_authFailure แต่แผนที่ค้าง ไม่เคยถึงสถานะ idle
      google.maps.event.addListenerOnce(map.raw, "tilesloaded", function () { ready = true; });
      setTimeout(fallback, 8000);
      refresh(true);
    }).catch(function () {
      useLeaflet("โหลด Google Maps ไม่สำเร็จ จึงใช้ OpenStreetMap แทน");
    });
  }

  // ---------- UI ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function setBadge(t) { $("engineBadge").textContent = "แผนที่: " + t; }

  // นำทางจากตำแหน่งปัจจุบันของผู้ใช้: ไม่ใส่ origin ให้ Google Maps ใช้ GPS ของเครื่อง (มือถือเปิดแอป Google Maps)
  function gmDirFromHereUrl(to) {
    return "https://www.google.com/maps/dir/?api=1&destination=" + ll(to) + "&travelmode=driving";
  }

  function popupHtml(p, i, hq) {
    var s = selNo(i);
    var info = p.info.length
      ? '<dl class="pp-info">' + p.info.map(function (f) {
          var v = H_PHONE.test(f.k) && /\d{3}/.test(f.v)
            ? '<a href="tel:' + esc(f.v.replace(/[^\d+]/g, "")) + '">' + esc(f.v) + "</a>"
            : esc(f.v);
          return "<dt>" + esc(f.k) + "</dt><dd>" + v + "</dd>";
        }).join("") + "</dl>"
      : "";
    return '<div class="pp">' +
      '<div class="pp-title">' + (i + 1) + ". " + esc(p.name) + "</div>" +
      info +
      (roadOf(p) && !roadOf(p).none
        ? '<div class="pp-road">ทางถนนจาก ' + esc(hq.name) + " <b>" + fmtLeg(roadOf(p)) + "</b></div>" : "") +
      '<div class="pp-sub">เส้นตรง ' + p.km.toFixed(1) + " กม. ทิศ" + dirName(p.deg) + " จาก " + esc(hq.name) + "</div>" +
      '<div class="pp-sub coord">' + ll(p) + "</div>" +
      '<div class="pp-actions">' +
      '<button type="button" class="pp-btn' + (s ? " on" : "") + '" data-sel="' + i + '">' +
        (s ? "เลือกตรวจแล้ว ลำดับที่ " + s + " (แตะเพื่อยกเลิก)" : "เลือกตรวจจุดนี้") + "</button>" +
      '<a class="pp-btn primary" href="' + gmDirFromHereUrl(p) + '" target="_blank" rel="noopener">นำทางจากตำแหน่งฉัน</a>' +
      '<a class="pp-btn ghost" href="' + gmPinUrl(p) + '" target="_blank" rel="noopener">เปิดหมุดใน Google Maps</a>' +
      "</div></div>";
  }

  function hqPopupHtml(hq) {
    return '<div class="pp"><div class="pp-title">' + esc(hq.name) + "</div>" +
      '<div class="pp-sub coord">' + ll(hq) + "</div>" +
      '<div class="pp-actions"><a class="pp-btn primary" href="' + gmDirFromHereUrl(hq) + '" target="_blank" rel="noopener">นำทางจากตำแหน่งฉัน</a></div></div>';
  }

  function showMsgs(msgs, append) {
    var box = $("messages");
    if (!append) box.innerHTML = "";
    msgs.forEach(function (m) {
      var d = document.createElement("div");
      d.className = "msg " + m.type; d.textContent = m.text; box.appendChild(d);
    });
  }

  function computeDistances() {
    state.points.forEach(function (p) {
      p.km = haversineKm(state.hq, p);
      p.deg = bearingDeg(state.hq, p);
    });
  }

  // ช่องระยะ: วนตรวจ = ช่วงจากจุดก่อนหน้า, อื่น ๆ = ระยะทางถนนจาก ภ.จว. ถ้ายังไม่ได้ผลหรือคำนวณไม่ได้ ใช้ระยะเส้นตรง
  function distCell(i, p) {
    var leg = state.view === "loop" ? legFor(i) : null;
    if (leg) {
      var k = state.sel.indexOf(i);
      return "<b>" + leg.km.toFixed(1) + ' กม.</b><span class="sub">' + fmtMin(leg.min) + (k ? " จากจุดที่ " + k : " จาก ภ.จว.") + "</span>";
    }
    var r = roadOf(p);
    if (r && !r.none) return "<b>" + r.km.toFixed(1) + ' กม.</b><span class="sub">' + fmtMin(r.min) + "</span>";
    return p.km.toFixed(1) + ' กม.<span class="sub">' +
      (r && r.none ? "เส้นตรง (ไม่พบทางถนน)" : roadState.busy ? "เส้นตรง กำลังคำนวณถนน" : "เส้นตรง") + "</span>";
  }

  function renderTable() {
    var tb = document.querySelector("#table tbody");
    var hq = state.hq;
    var rows = ['<tr class="hq"><td class="c-sel"></td><td class="c-no">ภ</td><td class="c-name"><b>' + esc(hq.name) + '</b><span class="sub">จุดอ้างอิง</span></td><td class="c-dist"></td><td class="c-act"></td></tr>'];
    state.points.forEach(function (p, i) {
      var s = selNo(i);
      // สภ. วันที่ เวลา (ถ้าช่องเวลามีวันที่ซ้ำอยู่ด้านหน้า ตัดออก)
      var parts = [];
      H_SUMMARY.forEach(function (re) {
        var f = p.info.filter(function (x) { return re.test(x.k); })[0];
        var v = f ? f.v : "";
        parts.forEach(function (q) { if (v.indexOf(q + " ") === 0) v = v.slice(q.length + 1); });
        if (v && parts.indexOf(v) < 0) parts.push(v);
      });
      var summary = parts.join(" ");
      rows.push('<tr data-i="' + i + '"' + (s ? ' class="picked"' : "") + '>' +
        '<td class="c-sel"><label class="pick" title="เลือกไปตรวจ"><input type="checkbox" data-pick="' + i + '"' + (s ? " checked" : "") +
          ' aria-label="เลือกตรวจ ' + esc(p.name) + '"></label></td>' +
        '<td class="c-no"><span class="no">' + (i + 1) + '</span></td>' +
        '<td class="c-name"><b>' + esc(p.name) + "</b>" +
        (s ? '<span class="sub go">ไปตรวจลำดับที่ ' + s + "</span>" : "") +
        (summary ? '<span class="sub">' + esc(summary) + "</span>" : "") +
        '<span class="sub">ทิศ' + dirName(p.deg) + "</span>" +
        "</td>" +
        '<td class="c-dist">' + distCell(i, p) + "</td>" +
        '<td class="c-act"><a class="navbtn" href="' + gmDirFromHereUrl(p) + '" target="_blank" rel="noopener" title="นำทางจากตำแหน่งปัจจุบันใน Google Maps">นำทาง</a></td></tr>');
    });
    tb.innerHTML = rows.join("");
    $("empty").style.display = state.points.length ? "none" : "block";

    // แถบจุดที่เลือกตรวจ
    var ns = state.sel.length, visit = $("btnVisit");
    $("visitbar").hidden = !state.points.length;
    $("btnSelClear").hidden = !ns;
    $("visitInfo").innerHTML = ns ? visitHtml() : esc("แตะช่องหน้าจุดที่จะไปตรวจ ตามลำดับที่จะไป (ไม่เกิน " + MAX_VISIT + " จุด)");
    if (ns) {
      visit.href = gmVisitUrl(state.sel.map(function (i) { return state.points[i]; }));
      visit.removeAttribute("aria-disabled");
    } else {
      visit.removeAttribute("href"); visit.setAttribute("aria-disabled", "true");
    }
    // มือถือ: จัดลำดับส่วนต่าง ๆ ตามว่ามีจุดแล้วหรือยัง และแสดงปุ่มนำทางติดขอบล่างเมื่อมีจุดที่เลือก
    document.body.classList.toggle("has-data", state.points.length > 0);
    document.body.classList.toggle("has-sel", ns > 0);
    $("visitDock").hidden = !ns;
    if (ns) {
      $("btnVisitDock").href = visit.href;
      $("btnVisitDock").textContent = "นำทางไป " + ns + " จุดที่เลือก";
    }
  }

  // รายการจุดที่เลือก พร้อมระยะทางถนนและเวลาแต่ละช่วง (คิดจาก ภ.จว. ตามลำดับที่เลือก) และผลรวม
  function visitHtml() {
    var r = loopRes(), n = state.sel.length;
    var items = state.sel.map(function (i, k) {
      var leg = r ? r.legs[k] : null;
      return "<li><b>" + esc(state.points[i].name) + "</b>" +
        (leg ? '<span class="leg">' + fmtLeg(leg) + (k ? " จากจุดที่ " + k : " จาก ภ.จว.") + "</span>" : "") + "</li>";
    }).join("");
    var sum = "";
    if (r) {
      var go = r.legs.slice(0, n).reduce(function (a, l) { return { km: a.km + l.km, min: a.min + l.min }; }, { km: 0, min: 0 });
      sum = '<p class="visitsum">รวมไป ' + n + " จุด <b>" + fmtLeg(go) + "</b> กลับ ภ.จว. " + fmtLeg(r.legs[n]) +
        " รวมทั้งวง " + fmtLeg(r) + "</p>";
    } else if (routeState.busy) sum = '<p class="visitsum">กำลังคำนวณระยะทางและเวลา</p>';
    else if (routeState.err) sum = '<p class="visitsum err">' + esc(routeState.err) + "</p>";
    return '<span class="visitcount">เลือกไว้ ' + n + ' จุด</span><ol class="visitlist">' + items + "</ol>" + sum;
  }

  function refresh(fit) {
    computeDistances();
    renderTable();
    if (map) { map.resize(); map.render(state.hq, state.points, routeLines()); if (fit) map.fit(state.hq, state.points); }
  }

  // วันที่ที่ต้องการแสดง (ค่าเริ่มต้น = วันนี้) 0 = ทุกวัน
  function selectedDay() {
    if (!$("chkDay").checked) return 0;
    var v = $("dayPick").value;   // yyyy-mm-dd
    return dayKey(v ? parseDay(v) : todayObj());
  }
  function keyToDay(k) { return { y: Math.floor(k / 10000), m: Math.floor(k / 100) % 100, d: k % 100 }; }

  function parseCurrent() { return parseInput($("input").value, { day: selectedDay() }); }

  // สรุปผลกรองวันที่ ข้อความขึ้นก่อนข้อความอื่น
  function dayMsgs(r) {
    var want = selectedDay(), keys = Object.keys(r.days).map(Number).sort(function (a, b) { return b - a; });
    if (!want || !keys.length) return [];
    var label = fmtDay(keyToDay(want)) + (want === dayKey(todayObj()) ? " (วันนี้)" : "");
    if (!r.points.length) {
      return [{ type: "warn", text: "ไม่มีข้อมูลของวันที่ " + label + " ในรายการ วันที่ที่มี: " +
        keys.map(function (k) { return fmtDay(keyToDay(k)) + " (" + r.days[k] + " แถว)"; }).join(", ") +
        " เปลี่ยนวันที่ด้านบน หรือเอาเครื่องหมายหน้า \"แสดงเฉพาะวันที่\" ออกเพื่อแสดงทุกวัน" }];
    }
    return [{ type: "ok", text: "แสดงเฉพาะวันที่ " + label + " " + r.points.length + " จุด" +
      (r.skipped ? " (ไม่แสดง " + r.skipped + " แถวของวันอื่น)" : "") }];
  }

  function plot() {
    var text = $("input").value;
    storeSet(STORE_INPUT, text);
    var r = parseCurrent();
    state.points = r.points;
    state.header = r.header;
    restoreSel();   // ชุดจุดเดิม = คงจุดที่เลือกไว้ ชุดใหม่ = ล้างการเลือก
    computeDistances();
    var far = state.points.filter(function (p) { return p.km > WARN_KM; });
    far.forEach(function (p) {
      r.msgs.push({ type: "warn", text: "บรรทัด " + p.line + ": \"" + p.name + "\" ห่าง " + p.km.toFixed(0) + " กม. ตรวจว่ากรอกถูกหรือไม่" });
    });
    var dm = dayMsgs(r);
    if (dm.length) r.msgs = dm.concat(r.msgs);
    else if (state.points.length) r.msgs.unshift({ type: "ok", text: "ปักหมุดแล้ว " + state.points.length + " จุด" });
    showMsgs(r.msgs);
    refresh(true);
    scheduleRoutes();
    scheduleRoad();
  }

  function fillHqForm() {
    $("hqName").value = state.hq.name;
    $("hqLat").value = state.hq.lat;
    $("hqLng").value = state.hq.lng;
  }

  // รูปแบบเดียวกับไฟล์ Excel จุดตรวจสัมพันธ์ (ชื่อ เบอร์ และพิกัดเป็นค่าสมมติ ไม่ใช่ข้อมูลจริง)
  // วันนี้ 5 จุด เมื่อวาน 2 จุด ให้เห็นการกรองเฉพาะวันนี้
  function sampleText() {
    var t = fmtDay(todayObj()), y = fmtDay(todayObj(-1));
    var row = function (a) { return a.join("\t"); };
    return [
      "# ตัวอย่างข้อมูลสาธิต (ค่าสมมติทั้งหมด ไม่ใช่ข้อมูลจริง)",
      row(KNOWN_COLS),
      row([y, "20:00", "สภ.เมืองเชียงราย", "ร.ต.ท. ตัวอย่าง สมมติหก", "รอง สว.(ป.)", "000-000-0006", "ตัวอย่าง (เมื่อวาน) หอนาฬิกา", "19.9073", "99.8310"]),
      row([y, "21:00", "สภ.แม่จัน", "ร.ต.อ. ตัวอย่าง สมมติเจ็ด", "รอง สว.(ป.)", "000-000-0007", "ตัวอย่าง (เมื่อวาน) ตลาดแม่จัน", "20.1460", "99.8530"]),
      row([t, "20:00", "สภ.เมืองเชียงราย", "ร.ต.ท. ตัวอย่าง สมมติหนึ่ง", "รอง สว.(ป.)", "000-000-0001", "ตัวอย่าง ร้านค้าตัวเมือง", "19.9100", "99.8400"]),
      row([t, "21:00", "สภ.แม่สาย", "ร.ต.อ. ตัวอย่าง สมมติสอง", "รอง สว.(ป.)", "000-000-0002", "ตัวอย่าง ตลาดแม่สาย", "20.4270", "99.8830"]),
      row([t, "21:30", "สภ.เชียงแสน", "ร.ต.ท. ตัวอย่าง สมมติสาม", "รอง สว.(ป.)", "000-000-0003", "ตัวอย่าง ท่าเรือเชียงแสน", "20.2730", "100.0840"]),
      row([t, "22:00", "สภ.แม่สรวย", "ร.ต.ต. ตัวอย่าง สมมติสี่", "รอง สว.(ป.)", "000-000-0004", "ตัวอย่าง ปั๊มน้ำมันแม่สรวย", "19.6600", "99.5300"]),
      row([t, "22:30", "สภ.เทิง", "ร.ต.อ. ตัวอย่าง สมมติห้า", "รอง สว.(ป.)", "000-000-0005", "ตัวอย่าง ร้านสะดวกซื้อเทิง", "19.8900", "100.2950"])
    ].join("\n");
  }

  // ---------- เริ่มทำงาน ----------
  document.addEventListener("DOMContentLoaded", function () {
    $("input").value = storeGet(STORE_INPUT) || "";
    fillHqForm();

    $("btnPlot").addEventListener("click", plot);
    $("input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) plot();
    });
    $("btnSample").addEventListener("click", function () { $("input").value = sampleText(); plot(); });
    // วางข้อความทั้งหมดที่คัดลอกมา (จาก Excel, Google Sheets, LINE) แล้วปักหมุดทันที
    $("input").addEventListener("paste", function () { setTimeout(plot, 0); });
    $("chkDay").addEventListener("change", plot);
    $("dayPick").addEventListener("change", function () { $("chkDay").checked = true; plot(); });
    $("btnClear").addEventListener("click", function () {
      $("input").value = ""; storeDel(STORE_INPUT); storeDel(STORE_SEL);
      state.points = []; state.header = null; state.sel = [];
      showMsgs([]); refresh(true); scheduleRoutes();
    });
    $("fileImport").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      e.target.value = "";
      showMsgs([{ type: "ok", text: "กำลังอ่านไฟล์ " + f.name }]);
      importFile(f).then(function (got) {
        $("input").value = got.tsv;
        plot();
        if (got.sheets) showMsgs([{ type: "ok", text: "อ่านไฟล์ " + f.name + " " + got.rows + " แถว จากแผ่นงาน " + got.sheets.join(", ") }], true);
      }, function (err) {
        showMsgs([{ type: "err", text: err.message || String(err) }]);
      });
    });
    // เลือกตรวจ: ช่องเลือกในตาราง และปุ่มในป๊อปอัปหมุด
    document.querySelector("#table tbody").addEventListener("change", function (e) {
      var cb = e.target.closest("input[data-pick]");
      if (cb) toggleSel(Number(cb.getAttribute("data-pick")));
    });
    // ป๊อปอัปของ Leaflet หยุดการส่งต่อ click จึงดักที่ช่วง capture
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-sel]");
      if (!b) return;
      e.preventDefault(); e.stopPropagation();   // ไม่ให้ click นี้ไปถึงแผนที่ (จะปิดป๊อปอัป)
      toggleSel(Number(b.getAttribute("data-sel")));
    }, true);
    $("btnSelClear").addEventListener("click", function () {
      state.sel = []; saveSel(); renderTable(); if (map) map.select(state.sel); scheduleRoutes();
    });
    document.querySelector("#table tbody").addEventListener("click", function (e) {
      if (e.target.closest("a, input, label")) return;
      var tr = e.target.closest("tr[data-i]");
      if (!tr || !map) return;
      // มือถือ: แผนที่อยู่ด้านบน เลื่อนขึ้นไปให้เห็นหมุด
      if (window.matchMedia("(max-width: 820px)").matches) $("map").scrollIntoView({ behavior: "smooth", block: "start" });
      map.focus(Number(tr.getAttribute("data-i")));
    });
    $("btnHqSave").addEventListener("click", function () {
      var lat = parseFloat($("hqLat").value), lng = parseFloat($("hqLng").value);
      if (!validLatLng(lat, lng)) { showMsgs([{ type: "err", text: "พิกัดจุดอ้างอิงไม่ถูกต้อง" }]); return; }
      state.hq = { name: $("hqName").value.trim() || DEFAULT_HQ.name, lat: lat, lng: lng };
      storeSet(STORE_HQ, JSON.stringify(state.hq));
      showMsgs([{ type: "ok", text: "บันทึกจุดอ้างอิงแล้ว" }]);
      refresh(true); scheduleRoutes(); scheduleRoad();
    });
    $("btnHqReset").addEventListener("click", function () {
      storeDel(STORE_HQ);
      state.hq = { name: DEFAULT_HQ.name, lat: DEFAULT_HQ.lat, lng: DEFAULT_HQ.lng };
      fillHqForm(); refresh(true); scheduleRoutes(); scheduleRoad();
    });
    window.addEventListener("resize", function () { if (map) map.resize(); });

    var t = todayObj();
    $("dayPick").value = t.y + "-" + pad2(t.m) + "-" + pad2(t.d);   // เปิดหน้าทุกครั้ง = วันนี้
    var r = parseCurrent();
    state.points = r.points;
    state.header = r.header;
    restoreSel();
    if ($("input").value.trim()) showMsgs(dayMsgs(r));
    initMap();
    // มุมมองบนแผนที่: เริ่มที่เส้นตรงทุกครั้ง
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (b) {
      b.addEventListener("click", function () { state.view = b.getAttribute("data-view"); scheduleRoutes(); });
    });
    scheduleRoutes();
    scheduleRoad();
  });

  // เปิดให้ทดสอบจาก console
  window.__policeMap = { parseInput: parseInput, haversineKm: haversineKm, bearingDeg: bearingDeg };
})();
