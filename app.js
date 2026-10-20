(function () {
  "use strict";

  var CFG = window.POLICE_MAP_CONFIG || {};
  var DEFAULT_HQ = CFG.hq || { name: "ภ.จว.เชียงราย", lat: 19.930841, lng: 99.877192 };
  var WARN_KM = CFG.warnDistanceKm || 200;
  var MAX_ROUTE_POINTS = 9;  // Google Maps URL: จุดแวะไม่เกิน 9 (ปลายทางคือ ภ.จว.)
  var STORE_INPUT = "policemap.input";
  var STORE_HQ = "policemap.hq";

  var $ = function (id) { return document.getElementById(id); };
  var state = { hq: loadHq(), points: [], route: null, routeMode: "line", optimize: true };
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

  function parseInput(text) {
    var points = [], msgs = [];
    text.split(/\r?\n/).forEach(function (line, idx) {
      var lineNo = idx + 1;
      var s = line.replace(/[°]/g, "").trim();
      if (!s || s.charAt(0) === "#") return;

      // แยกด้วย tab, comma, semicolon หรือช่องว่าง (2 ค่าแรกต้องเป็นตัวเลข)
      var parts = s.split(/\t|,|;/).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length < 2 || !isNum(parts[0]) || !isNum(parts[1])) {
        var ws = s.split(/\s+/);
        if (ws.length >= 2 && isNum(ws[0]) && isNum(ws[1])) {
          parts = [ws[0], ws[1], ws.slice(2).join(" ")];
        }
      }
      // ข้ามหัวตาราง เช่น "lat,lng,name"
      if (parts.length >= 2 && !isNum(parts[0]) && !isNum(parts[1]) && points.length === 0 && idx === 0) return;

      if (parts.length < 2 || !isNum(parts[0]) || !isNum(parts[1])) {
        msgs.push({ type: "err", text: "บรรทัด " + lineNo + ": อ่านพิกัดไม่ได้ \"" + line.trim() + "\"" });
        return;
      }
      var lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
      var name = parts.slice(2).join(" ").replace(/^"|"$/g, "").trim();

      // สลับให้อัตโนมัติถ้ากรอกกลับด้าน (ประเทศไทย lat 5-21, lng 97-106)
      if ((Math.abs(lat) > 90 && Math.abs(lng) <= 90) ||
          (lat >= 97 && lat <= 106 && lng >= 5 && lng <= 21)) {
        var t = lat; lat = lng; lng = t;
        msgs.push({ type: "warn", text: "บรรทัด " + lineNo + ": สลับละติจูด/ลองจิจูดให้อัตโนมัติ" });
      }
      if (!validLatLng(lat, lng)) {
        msgs.push({ type: "err", text: "บรรทัด " + lineNo + ": พิกัดอยู่นอกช่วงที่ถูกต้อง" });
        return;
      }
      points.push({ lat: lat, lng: lng, name: name || ("จุดที่ " + (points.length + 1)), line: lineNo });
    });
    return { points: points, msgs: msgs };
  }
  function isNum(s) { return typeof s === "string" && new RegExp("^" + NUM.source + "$").test(s.trim()); }

  // ---------- ลิงก์ Google Maps (ไม่ต้องใช้ key) ----------
  function ll(p) { return p.lat.toFixed(6) + "," + p.lng.toFixed(6); }
  function gmPinUrl(p) { return "https://www.google.com/maps/search/?api=1&query=" + ll(p); }
  function gmDirUrl(from, to) {
    return "https://www.google.com/maps/dir/?api=1&origin=" + ll(from) + "&destination=" + ll(to) + "&travelmode=driving";
  }
  // ภ.จว. ผ่านทุกจุดตามลำดับแล้วกลับ ภ.จว. (ตรงกับโหมดตรวจต่อเนื่อง)
  function gmRouteUrl(from, pts) {
    return gmDirUrl(from, from) + "&waypoints=" + encodeURIComponent(pts.map(ll).join("|"));
  }

  // ---------- เส้นทางถนน ----------
  // mode "star" = ภ.จว. ไปแต่ละจุด, "loop" = ภ.จว. ผ่านทุกจุดตามลำดับแล้วกลับ ภ.จว.
  var ROUTE_COLOR = { star: "#0b57d0", loop: "#7b1fa2" };
  var MAX_LOOP_POINTS = 25;          // Google Directions รับจุดแวะได้ 25 จุด ใช้เพดานเดียวกันทั้งสองระบบ
  var OSRM_URL = "https://router.project-osrm.org"; // เปลี่ยนเป็นเซิร์ฟเวอร์ OSRM ของหน่วยงานได้
  var OSRM_GAP_MS = 1100;            // นโยบายเซิร์ฟเวอร์สาธิต OSRM: ไม่เกิน 1 ครั้งต่อวินาที
  var routeJob = 0;                  // เพิ่มทุกครั้งที่ข้อมูลเปลี่ยน ผลลัพธ์เก่าที่มาช้าจะถูกทิ้ง
  var googleRouteFailed = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // คืนค่า { km, min, legs:[{km,min}], path:[[lat,lng],...] }
  function osrmRoute(coords) {
    var q = coords.map(function (c) { return c.lng.toFixed(6) + "," + c.lat.toFixed(6); }).join(";");
    return fetch(OSRM_URL + "/route/v1/driving/" + q + "?overview=full&geometries=geojson&steps=false")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error(j.message || j.code || "NoRoute");
        var rt = j.routes[0];
        return {
          km: rt.distance / 1000, min: rt.duration / 60,
          legs: rt.legs.map(function (l) { return { km: l.distance / 1000, min: l.duration / 60 }; }),
          path: rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; })
        };
      });
  }

  function googleRoute(coords) {
    var g = google.maps;
    var svc = googleRoute.svc || (googleRoute.svc = new g.DirectionsService());
    var toLL = function (c) { return { lat: c.lat, lng: c.lng }; };
    return svc.route({
      origin: toLL(coords[0]), destination: toLL(coords[coords.length - 1]),
      waypoints: coords.slice(1, -1).map(function (c) { return { location: toLL(c), stopover: true }; }),
      travelMode: g.TravelMode.DRIVING, region: "th"
    }).then(function (res) {
      var rt = res.routes[0];
      var legs = rt.legs.map(function (l) { return { km: l.distance.value / 1000, min: l.duration.value / 60 }; });
      return {
        km: legs.reduce(function (s, l) { return s + l.km; }, 0),
        min: legs.reduce(function (s, l) { return s + l.min; }, 0),
        legs: legs,
        path: rt.overview_path.map(function (p) { return [p.lat(), p.lng()]; })
      };
    });
  }

  // จัดลำดับให้สั้นที่สุด: coords = [ภ.จว., จุด1..n] เริ่มและจบที่ ภ.จว.
  // คืนค่าเหมือน osrmRoute และเพิ่ม order = ลำดับ index ของจุด (0..n-1) ตามการวิ่ง
  function osrmTrip(coords) {
    var q = coords.map(function (c) { return c.lng.toFixed(6) + "," + c.lat.toFixed(6); }).join(";");
    return fetch(OSRM_URL + "/trip/v1/driving/" + q + "?source=first&roundtrip=true&overview=full&geometries=geojson&steps=false")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        if (j.code !== "Ok" || !j.trips || !j.trips.length) throw new Error(j.message || j.code || "NoTrip");
        var t = j.trips[0];
        var order = j.waypoints.map(function (w, idx) { return { idx: idx, pos: w.waypoint_index }; })
          .filter(function (w) { return w.idx > 0; })
          .sort(function (a, b) { return a.pos - b.pos; })
          .map(function (w) { return w.idx - 1; });
        return {
          km: t.distance / 1000, min: t.duration / 60, order: order,
          legs: t.legs.map(function (l) { return { km: l.distance / 1000, min: l.duration / 60 }; }),
          path: t.geometry.coordinates.map(function (c) { return [c[1], c[0]]; })
        };
      });
  }

  function googleTrip(coords) {
    var g = google.maps;
    var svc = googleRoute.svc || (googleRoute.svc = new g.DirectionsService());
    var toLL = function (c) { return { lat: c.lat, lng: c.lng }; };
    return svc.route({
      origin: toLL(coords[0]), destination: toLL(coords[0]), optimizeWaypoints: true,
      waypoints: coords.slice(1).map(function (c) { return { location: toLL(c), stopover: true }; }),
      travelMode: g.TravelMode.DRIVING, region: "th"
    }).then(function (res) {
      var rt = res.routes[0];
      var legs = rt.legs.map(function (l) { return { km: l.distance.value / 1000, min: l.duration.value / 60 }; });
      return {
        km: legs.reduce(function (s, l) { return s + l.km; }, 0),
        min: legs.reduce(function (s, l) { return s + l.min; }, 0),
        legs: legs, order: rt.waypoint_order.slice(),
        path: rt.overview_path.map(function (p) { return [p.lat(), p.lng()]; })
      };
    });
  }

  function usingGoogle() { return map && map.name === "Google Maps" && !googleRouteFailed; }

  function routeVia(coords, optimize) {
    var osrm = optimize ? osrmTrip : osrmRoute;
    if (!usingGoogle()) return osrm(coords);
    return (optimize ? googleTrip : googleRoute)(coords).catch(function (e) {
      // ถ้า key ไม่ได้เปิด Directions API จะได้ REQUEST_DENIED ใช้ OSRM แทนตลอดรอบนี้
      if (/DENIED|NOT_AUTHORIZED|OVER_QUERY_LIMIT/.test(String(e && (e.code || e.message)))) {
        googleRouteFailed = true;
        showMsgs([{ type: "warn", text: "Google Directions ใช้ไม่ได้กับ key นี้ (ต้องเปิด Directions API) จึงใช้ OSRM แทน" }], true);
        return osrm(coords);
      }
      throw e;
    });
  }

  function engineName() { return usingGoogle() ? "Google Directions" : "OSRM (OpenStreetMap)"; }

  function fmtMin(min) {
    var m = Math.round(min);
    if (m < 60) return m + " นาที";
    return Math.floor(m / 60) + " ชม. " + (m % 60) + " นาที";
  }

  var MODES = { star: "จาก ภ.จว. ไปแต่ละจุด", loop: "ตรวจต่อเนื่อง วนกลับ", line: "เส้นตรง" };
  var routeCache = {};               // ผลเส้นทางที่เคยหาแล้ว ไม่ต้องเรียกซ้ำ

  function cachedRoute(coords, optimize) {
    var key = (usingGoogle() ? "g" : "o") + (optimize ? "t:" : "r:") + coords.map(ll).join(";");
    if (routeCache[key]) return Promise.resolve({ r: routeCache[key], hit: true });
    return routeVia(coords, optimize).then(function (r) { routeCache[key] = r; return { r: r, hit: false }; });
  }

  // ระยะถนนของจุดที่ i: โหมดไปแต่ละจุด = จาก ภ.จว., โหมดวนตรวจ = ช่วงที่มาถึงจุดนั้น
  function legFor(i) {
    var r = state.route;
    if (!r) return null;
    if (r.mode === "star") return r.legs[i];
    var k = r.order.indexOf(i);
    return k < 0 ? null : r.legs[k];
  }
  function visitNo(i) { var r = state.route; return r && r.mode === "loop" ? r.order.indexOf(i) + 1 : 0; }

  function routeStatus(text, type) {
    var el = $("routeStatus");
    el.textContent = text || "";
    el.className = "routestatus" + (type ? " " + type : "");
  }

  function setMode(mode) {
    state.routeMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-mode") === mode ? "true" : "false");
    });
  }

  // หาเส้นทางตามโหมดปัจจุบัน (เรียกอัตโนมัติหลังปักหมุด)
  function autoRoute() {
    clearRoute();
    if (state.routeMode === "line" || !state.points.length || !map) { routeStatus(""); refresh(false); return; }
    runRoute(state.routeMode);
  }

  function runRoute(mode) {
    var pts = state.points.slice(), hq = state.hq;
    if (!pts.length) return;
    if (mode === "loop" && pts.length > MAX_LOOP_POINTS) {
      routeStatus("เส้นทางตรวจต่อเนื่องรองรับไม่เกิน " + MAX_LOOP_POINTS + " จุด เลือกโหมดอื่นแทน", "err"); return;
    }
    var job = ++routeJob;
    var ok = function () { return job === routeJob; };
    var engine = engineName();

    var done;
    if (mode === "loop") {
      var opt = state.optimize && pts.length > 1;
      routeStatus((opt ? "กำลังจัดลำดับและหาเส้นทาง " : "กำลังหาเส้นทางตรวจต่อเนื่อง ") + pts.length + " จุด", "busy");
      var coords = opt ? [hq].concat(pts) : [hq].concat(pts, [hq]);
      done = cachedRoute(coords, opt).then(function (x) {
        if (!ok()) return;
        var r = x.r;
        var order = r.order || pts.map(function (_, i) { return i; });
        var changed = order.some(function (v, k) { return v !== k; });
        state.route = {
          mode: "loop", engine: engine, legs: r.legs, total: { km: r.km, min: r.min },
          order: order, optimized: opt, reordered: changed,
          lines: [{ path: r.path, label: "รวม " + r.km.toFixed(1) + " กม. " + fmtMin(r.min) }]
        };
        routeStatus((opt ? "ลำดับที่สั้นที่สุด" : "ตามลำดับที่กรอก") + " (รวมขากลับ) " + r.km.toFixed(1) +
          " กม. ประมาณ " + fmtMin(r.min), "ok");
      });
    } else {
      // วาดทีละเส้นทันทีที่ได้ผล ผู้ใช้เห็นเส้นทางค่อย ๆ ขึ้นบนแผนที่
      state.route = { mode: "star", engine: engine, legs: new Array(pts.length).fill(null), lines: [] };
      var failed = [];
      var gap = usingGoogle() ? 150 : OSRM_GAP_MS;
      done = pts.reduce(function (chain, p, i) {
        return chain.then(function () {
          if (!ok()) return;
          routeStatus("กำลังหาเส้นทาง " + (i + 1) + "/" + pts.length + " (" + p.name + ")", "busy");
          return cachedRoute([hq, p]).then(function (x) {
            if (!ok()) return;
            state.route.legs[i] = { km: x.r.km, min: x.r.min };
            state.route.lines.push({ path: x.r.path, label: (i + 1) + ". " + p.name + ": " + x.r.km.toFixed(1) + " กม. " + fmtMin(x.r.min) });
            refresh(false);
            if (!x.hit && i < pts.length - 1) return sleep(gap);
          }, function () { failed.push(i + 1); });
        });
      }, Promise.resolve()).then(function () {
        if (!ok()) return;
        routeStatus(failed.length
          ? "หาเส้นทางไม่ได้: จุดที่ " + failed.join(", ") + " (อาจไม่มีถนนเข้าถึง)"
          : "เส้นทางจาก " + hq.name + " ครบ " + pts.length + " จุด", failed.length ? "warn" : "ok");
      });
    }
    done.catch(function (e) {
      if (ok()) routeStatus("หาเส้นทางไม่สำเร็จ: " + (e && e.message ? e.message : e) + " ลองเลือกโหมดใหม่อีกครั้ง", "err");
    }).then(function () { if (ok()) refresh(false); });
  }

  function clearRoute() {
    routeJob++;
    state.route = null;
  }

  // หมุดวาดใหม่เฉพาะเมื่อจุดหรือ ภ.จว. เปลี่ยน เส้นทางวาดแยกชั้น ป๊อปอัปที่เปิดอยู่จึงไม่ปิดเองระหว่างหาเส้นทาง
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

    function icon(label, isHq) {
      return L.divIcon({
        className: "", iconSize: isHq ? [34, 34] : [28, 28], iconAnchor: isHq ? [17, 34] : [14, 28],
        popupAnchor: [0, -28],
        html: '<div class="pin' + (isHq ? " hq" : "") + '"><span>' + esc(label) + "</span></div>"
      });
    }
    return {
      name: "OpenStreetMap",
      render: function (hq, pts, route) {
        lineLayer.clearLayers();
        if (route) {
          route.lines.forEach(function (ln) {
            L.polyline(ln.path, { color: ROUTE_COLOR[route.mode], weight: 4, opacity: .8 })
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
    return {
      name: "Google Maps",
      raw: m,
      render: function (hq, pts, route) {
        lines.forEach(function (o) { o.setMap(null); }); lines = [];
        if (route) {
          route.lines.forEach(function (ln) {
            var pl = new g.Polyline({
              map: m, path: ln.path.map(function (c) { return { lat: c[0], lng: c[1] }; }),
              strokeColor: ROUTE_COLOR[route.mode], strokeOpacity: .8, strokeWeight: 4
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
    autoRoute();
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
      autoRoute();
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
    var r = state.route, leg = legFor(i), k = visitNo(i);
    var road = leg
      ? '<div class="pp-road"><b>' + leg.km.toFixed(1) + " กม.</b> " + fmtMin(leg.min) +
        '<span class="pp-sub">' + (r.mode === "star" ? "ทางถนนจาก ภ.จว." : "ทางถนนจากจุดก่อนหน้า (แวะลำดับที่ " + k + ")") + "</span></div>"
      : "";
    return '<div class="pp">' +
      '<div class="pp-title">' + (i + 1) + ". " + esc(p.name) + "</div>" +
      road +
      '<div class="pp-sub">เส้นตรง ' + p.km.toFixed(1) + " กม. ทิศ" + dirName(p.deg) + " จาก " + esc(hq.name) + "</div>" +
      '<div class="pp-sub coord">' + ll(p) + "</div>" +
      '<div class="pp-actions">' +
      '<a class="pp-btn primary" href="' + gmDirUrl(hq, p) + '" target="_blank" rel="noopener">นำทางจาก ภ.จว.</a>' +
      '<a class="pp-btn" href="' + gmDirFromHereUrl(p) + '" target="_blank" rel="noopener">นำทางจากตำแหน่งฉัน</a>' +
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

  function renderTable() {
    var tb = document.querySelector("#table tbody");
    var hq = state.hq;
    var rt = state.route;
    $("thRoad").textContent = rt && rt.mode === "loop" ? "ช่วงถนน" : "ระยะ";
    var dist = function (leg, straightKm) {
      if (leg) return '<b>' + leg.km.toFixed(1) + ' กม.</b><span class="sub">' + fmtMin(leg.min) + "</span>";
      var s2 = straightKm == null ? "" : straightKm.toFixed(1) + " กม.";
      var pending = rt && rt.mode !== "line" ? '<span class="sub">กำลังหาเส้นทาง</span>' : '<span class="sub">เส้นตรง</span>';
      return straightKm == null ? "-" : s2 + pending;
    };
    var rows = ['<tr class="hq"><td class="c-no">ภ</td><td class="c-name"><b>' + esc(hq.name) + '</b><span class="sub">จุดอ้างอิง</span></td><td class="c-dist"></td><td class="c-act"></td></tr>'];
    // โหมดวนตรวจเรียงแถวตามลำดับการวิ่ง ตัวเลขในวงกลมยังเป็นเลขหมุดบนแผนที่
    var seq = rt && rt.mode === "loop" ? rt.order : state.points.map(function (_, i) { return i; });
    seq.forEach(function (i, k) {
      var p = state.points[i];
      var visit = rt && rt.mode === "loop" ? '<span class="sub visit">แวะลำดับที่ ' + (k + 1) + "</span>" : "";
      rows.push('<tr data-i="' + i + '"><td class="c-no"><span class="no">' + (i + 1) + '</span></td>' +
        '<td class="c-name"><b>' + esc(p.name) + "</b>" + visit + '<span class="sub">' + "ทิศ" + dirName(p.deg) + (rt ? " เส้นตรง " + p.km.toFixed(1) + " กม." : "") + "</span>" +
        "</td>" +
        '<td class="c-dist">' + dist(legFor(i), p.km) + "</td>" +
        '<td class="c-act"><a class="navbtn" href="' + gmDirUrl(hq, p) + '" target="_blank" rel="noopener" title="นำทางจาก ภ.จว. ใน Google Maps">นำทาง</a></td></tr>');
    });
    if (rt && rt.mode === "loop" && state.points.length) {
      rows.push('<tr class="sum"><td></td><td class="c-name">กลับ ' + esc(hq.name) + '</td><td class="c-dist">' + dist(rt.legs[state.points.length], null) + "</td><td></td></tr>");
      rows.push('<tr class="sum total"><td></td><td class="c-name"><b>รวมทั้งเส้นทาง</b></td><td class="c-dist">' + dist(rt.total, null) + "</td><td></td></tr>");
    }
    $("routeInfo").textContent = rt ? "เส้นทางคำนวณโดย " + rt.engine + " (พิกัดถูกส่งไปยังบริการนี้เพื่อคำนวณ) เวลาเป็นค่าประมาณสำหรับรถยนต์ ไม่รวมสภาพจราจร" : "";
    tb.innerHTML = rows.join("");
    $("empty").style.display = state.points.length ? "none" : "block";
    $("loopOpts").hidden = state.routeMode !== "loop";
    $("btnApplyOrder").hidden = !(rt && rt.mode === "loop" && rt.reordered);

    var route = $("btnRoute");
    var n = state.points.length;
    if (n === 0 || n > MAX_ROUTE_POINTS) {
      route.removeAttribute("href"); route.setAttribute("aria-disabled", "true");
      route.title = n ? "Google Maps รองรับได้ไม่เกิน " + MAX_ROUTE_POINTS + " จุดต่อเส้นทาง" : "";
    } else {
      var ordered = rt && rt.mode === "loop" ? rt.order.map(function (i) { return state.points[i]; }) : state.points;
      route.href = gmRouteUrl(hq, ordered); route.removeAttribute("aria-disabled"); route.title = "";
    }
  }

  function refresh(fit) {
    computeDistances();
    renderTable();
    if (map) { map.resize(); map.render(state.hq, state.points, state.route); if (fit) map.fit(state.hq, state.points); }
  }

  function plot() {
    var text = $("input").value;
    storeSet(STORE_INPUT, text);
    var r = parseInput(text);
    clearRoute();
    state.points = r.points;
    computeDistances();
    var far = state.points.filter(function (p) { return p.km > WARN_KM; });
    far.forEach(function (p) {
      r.msgs.push({ type: "warn", text: "บรรทัด " + p.line + ": \"" + p.name + "\" ห่าง " + p.km.toFixed(0) + " กม. ตรวจว่ากรอกถูกหรือไม่" });
    });
    if (state.points.length) r.msgs.unshift({ type: "ok", text: "ปักหมุดแล้ว " + state.points.length + " จุด" });
    if (state.points.length > MAX_ROUTE_POINTS) {
      r.msgs.push({ type: "warn", text: "ลิงก์นำทางวนใน Google Maps ใช้ได้ไม่เกิน " + MAX_ROUTE_POINTS + " จุด (ข้อจำกัดของ Google Maps) ใช้ลิงก์นำทางรายจุดแทน" });
    }
    showMsgs(r.msgs);
    refresh(true);
    autoRoute();
  }

  function exportCsv() {
    var hq = state.hq;
    var rt = state.route;
    var roadHead = rt && rt.mode === "loop" ? "ช่วงถนนจากจุดก่อนหน้า" : "ถนนจาก " + hq.name;
    var loop = rt && rt.mode === "loop";
    var lines = [["ลำดับ", "ลำดับการวิ่ง", "ชื่อจุด", "ละติจูด", "ลองจิจูด", "ระยะเส้นตรงจาก " + hq.name + " (กม.)", "ทิศ",
      roadHead + " (กม.)", "เวลาโดยประมาณ (นาที)", "ลิงก์ Google Maps", "ลิงก์นำทาง"]];
    var road = function (leg) { return leg ? [leg.km.toFixed(2), Math.round(leg.min)] : ["", ""]; };
    var seq = loop ? rt.order : state.points.map(function (_, i) { return i; });
    seq.forEach(function (i, k) {
      var p = state.points[i];
      lines.push([i + 1, loop ? k + 1 : "", p.name, p.lat.toFixed(6), p.lng.toFixed(6), p.km.toFixed(2), dirName(p.deg)]
        .concat(road(legFor(i)), [gmPinUrl(p), gmDirUrl(hq, p)]));
    });
    if (loop) {
      lines.push(["", "", "กลับ " + hq.name, "", "", "", ""].concat(road(rt.legs[state.points.length]), ["", ""]));
      lines.push(["", "", "รวมทั้งเส้นทาง" + (rt.optimized ? " (จัดลำดับให้สั้นที่สุด)" : " (ตามลำดับที่กรอก)"), "", "", "", ""].concat(road(rt.total), ["", ""]));
    }
    if (rt) lines.push(["", "", "เส้นทางคำนวณโดย " + rt.engine]);
    var csv = lines.map(function (r) {
      return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM ให้ Excel อ่านไทยได้
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "police-map-points.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function fillHqForm() {
    $("hqName").value = state.hq.name;
    $("hqLat").value = state.hq.lat;
    $("hqLng").value = state.hq.lng;
  }

  var SAMPLE = [
    "# ตัวอย่างข้อมูลสาธิต (พิกัดโดยประมาณ ไม่ใช่ข้อมูลจริง)",
    "19.9100, 99.8400, ตัวอย่าง ตัวเมืองเชียงราย",
    "20.4270, 99.8830, ตัวอย่าง แม่สาย",
    "20.2730, 100.0840, ตัวอย่าง เชียงแสน",
    "19.6600, 99.5300, ตัวอย่าง แม่สรวย",
    "19.8900, 100.2950, ตัวอย่าง เทิง"
  ].join("\n");

  // ---------- เริ่มทำงาน ----------
  document.addEventListener("DOMContentLoaded", function () {
    $("input").value = storeGet(STORE_INPUT) || "";
    fillHqForm();

    $("btnPlot").addEventListener("click", plot);
    $("input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) plot();
    });
    $("btnSample").addEventListener("click", function () { $("input").value = SAMPLE; plot(); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"), function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); autoRoute(); });
    });
    $("chkOptimize").addEventListener("change", function () {
      state.optimize = $("chkOptimize").checked; autoRoute();
    });
    // เขียนรายการใหม่ตามลำดับการวิ่ง เลขหมุดบนแผนที่จะตรงกับลำดับที่ต้องแวะ
    $("btnApplyOrder").addEventListener("click", function () {
      var rt = state.route; if (!rt || !rt.order) return;
      $("input").value = rt.order.map(function (i) {
        var p = state.points[i];
        return p.lat.toFixed(6) + ", " + p.lng.toFixed(6) + ", " + p.name.replace(/,/g, " ");
      }).join("\n");
      plot();
    });
    $("btnClear").addEventListener("click", function () {
      clearRoute();
      $("input").value = ""; storeDel(STORE_INPUT); state.points = []; showMsgs([]); routeStatus(""); refresh(true);
    });
    $("btnFit").addEventListener("click", function () { if (map) map.fit(state.hq, state.points); });
    $("btnExport").addEventListener("click", function () {
      if (!state.points.length) { showMsgs([{ type: "warn", text: "ยังไม่มีจุดให้ส่งออก" }]); return; }
      exportCsv();
    });
    $("fileCsv").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { $("input").value = String(rd.result).replace(/^﻿/, ""); plot(); e.target.value = ""; };
      rd.readAsText(f, "utf-8");
    });
    document.querySelector("#table tbody").addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
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
      clearRoute();
      showMsgs([{ type: "ok", text: "บันทึกจุดอ้างอิงแล้ว" }]);
      refresh(true);
      autoRoute();
    });
    $("btnHqReset").addEventListener("click", function () {
      storeDel(STORE_HQ);
      clearRoute();
      state.hq = { name: DEFAULT_HQ.name, lat: DEFAULT_HQ.lat, lng: DEFAULT_HQ.lng };
      fillHqForm(); refresh(true); autoRoute();
    });
    window.addEventListener("resize", function () { if (map) map.resize(); });

    // เริ่มที่โหมดเส้นตรงทุกครั้ง พิกัดจะถูกส่งออกนอกเครื่องก็ต่อเมื่อผู้ใช้เลือกโหมดเส้นทางถนนเอง
    setMode("line");
    var r = parseInput($("input").value);
    state.points = r.points;
    initMap();
  });

  // เปิดให้ทดสอบจาก console
  window.__policeMap = { parseInput: parseInput, haversineKm: haversineKm, bearingDeg: bearingDeg };
})();
