/* Road Plan — 地名・住所検索（国土地理院 住所検索 API + OpenStreetMap Nominatim） */
'use strict';

/* 住所らしい入力か（番地・丁目・都道府県市区町村を含む）。住所は地理院、施設名・駅名などは OSM の方が当たりやすい */
const looksLikeAddress = (q) => /[都道府県市区町村郡]|丁目|番地|[0-9０-９]+\s*[-－ー−‐の]\s*[0-9０-９]/.test(q);
const toHalf = (s) => s.replace(/[０-９．，－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/* 「35.68, 139.76」「35.68 139.76」形式の緯度経度 */
function parseLatLng(q) {
  const m = toHalf(q).trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  let a = +m[1], b = +m[2];
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a]; // 経度, 緯度 の順でも受け付ける
  return Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { lat: a, lng: b } : null;
}

async function searchGSI(q, signal) {
  const r = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q), { signal });
  if (!r.ok) throw new Error('地理院 ' + r.status);
  const js = await r.json();
  return (Array.isArray(js) ? js : []).slice(0, 8).map((f) => ({
    name: f.properties.title, sub: '住所・地名', src: '地理院',
    lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], zoom: 17,
  }));
}

async function searchOSM(q, signal) {
  const b = map.getBounds();
  const p = new URLSearchParams({ q, format: 'jsonv2', limit: '8', 'accept-language': 'ja', addressdetails: '0',
    viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map((v) => v.toFixed(5)).join(',') });
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + p, { signal });
  if (!r.ok) throw new Error('OSM ' + r.status);
  const js = await r.json();
  return js.map((x) => {
    // 日本の display_name は「番地, 町, 区, 都, 〒, 日本」の逆順なので、名称以外を日本式の並びに直す
    const parts = x.display_name.split(',').map((s) => s.trim()).filter((s) => s && s !== '日本' && !/^\d{3}-?\d{4}$/.test(s));
    const name = x.name || parts[0];
    const rest = (parts[0] === name ? parts.slice(1) : parts).reverse().join(' ');
    const bb = x.boundingbox && x.boundingbox.map(Number); // [南, 北, 西, 東]
    return { name, sub: rest, src: 'OSM', lat: +x.lat, lng: +x.lon, bounds: bb && [[bb[0], bb[2]], [bb[1], bb[3]]] };
  });
}

/* 結果の統合: 住所らしければ地理院を先に。ほぼ同じ場所・同名の重複は除く */
function mergeResults(q, gsi, osm) {
  const list = looksLikeAddress(q) ? [...gsi, ...osm] : [...osm, ...gsi];
  const out = [];
  for (const r of list) {
    if (out.some((o) => o.name === r.name && map.distance([o.lat, o.lng], [r.lat, r.lng]) < 100)) continue;
    out.push(r);
  }
  return out.slice(0, 10);
}

const Search = {
  el: null, input: null, list: null, results: [], active: -1, marker: null, ctrl: null,

  init() {
    const box = document.createElement('div');
    box.id = 'search';
    box.innerHTML = `<form autocomplete="off" role="search">
        <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input type="search" id="searchInput" placeholder="地名・住所・施設名・緯度経度で検索" aria-label="地図を検索" spellcheck="false" enterkeyhint="search">
        <button type="button" class="clr" title="クリア" hidden><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </form><div class="sr-list" role="listbox" hidden></div>`;
    $('#stage').appendChild(box);
    L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
    this.el = box; this.input = $('input', box); this.list = $('.sr-list', box); this.clr = $('.clr', box);

    $('form', box).addEventListener('submit', (e) => { e.preventDefault(); this.run(); });
    this.input.addEventListener('input', () => { this.clr.hidden = !this.input.value; if (!this.input.value) this.hideList(); });
    this.input.addEventListener('focus', () => { if (this.results.length) this.showList(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Enter で blur する全体ハンドラやショートカットに渡さない
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!this.results.length) return;
        e.preventDefault(); this.showList();
        const n = this.results.length;
        this.setActive((this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      } else if (e.key === 'Enter' && this.active >= 0 && !this.list.hidden) {
        e.preventDefault(); this.go(this.results[this.active]);
      } else if (e.key === 'Escape') {
        if (!this.list.hidden) this.hideList(); else this.input.blur();
      }
    });
    this.clr.addEventListener('click', () => this.clear());
    this.list.addEventListener('mousedown', (e) => e.preventDefault()); // クリック時に入力のフォーカスを保つ
    this.list.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) this.go(this.results[+it.dataset.i]); });
    this.list.addEventListener('mousemove', (e) => { const it = e.target.closest('[data-i]'); if (it && +it.dataset.i !== this.active) this.setActive(+it.dataset.i); });
    document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) this.hideList(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && $('#modal').hidden) { e.preventDefault(); this.input.focus(); this.input.select(); }
    });
  },

  async run() {
    const q = this.input.value.trim();
    if (!q) return;
    const ll = parseLatLng(q);
    if (ll) { this.results = []; this.hideList(); this.go({ name: `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`, sub: '緯度経度', ...ll, zoom: Math.max(map.getZoom(), 17) }); return; }
    if (this.ctrl) this.ctrl.abort();
    const ctrl = (this.ctrl = new AbortController());
    this.renderList(null);
    const [g, o] = await Promise.allSettled([searchGSI(q, ctrl.signal), searchOSM(q, ctrl.signal)]);
    if (ctrl.signal.aborted) return;
    this.ctrl = null;
    const val = (s) => (s.status === 'fulfilled' ? s.value : []);
    this.results = mergeResults(q, val(g), val(o));
    const failed = [g, o].filter((s) => s.status === 'rejected').length;
    this.renderList(this.results, failed === 2 ? '検索サービスに接続できません' : null);
    if (this.results.length) this.setActive(0);
  },

  renderList(items, err) {
    this.active = -1;
    this.list.innerHTML = items == null ? '<div class="sr-msg">検索中…</div>'
      : items.length ? items.map((r, i) => `<div class="sr-it" role="option" data-i="${i}">
          <svg class="ic" viewBox="0 0 24 24"><path d="M12 21s-6-5.6-6-10.5a6 6 0 0112 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/></svg>
          <span class="tx"><b>${esc(r.name)}</b><span>${esc(r.sub || '')}</span></span><span class="src">${r.src}</span></div>`).join('')
      : `<div class="sr-msg">${err || '見つかりませんでした。住所は「市区町村＋町名＋番地」、施設は正式名称で試してください'}</div>`;
    this.showList();
  },
  setActive(i) {
    this.active = i;
    this.list.querySelectorAll('.sr-it').forEach((el) => el.classList.toggle('on', +el.dataset.i === i));
    const el = this.list.querySelector('.sr-it.on'); if (el) el.scrollIntoView({ block: 'nearest' });
  },
  showList() { this.list.hidden = false; },
  hideList() { this.list.hidden = true; },

  go(r) {
    this.hideList();
    if (r.bounds && map.distance(r.bounds[0], r.bounds[1]) > 150) map.flyToBounds(r.bounds, { maxZoom: 18, padding: [40, 40], duration: 0.8 });
    else map.flyTo([r.lat, r.lng], r.zoom || 18, { duration: 0.8 });
    if (this.marker) this.marker.remove();
    this.marker = L.marker([r.lat, r.lng], {
      pane: 'labels', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'sr-pin', iconSize: [26, 34], iconAnchor: [13, 33],
        html: '<svg viewBox="0 0 26 34"><path d="M13 33S2 20.500 2 12.500a11 11 0 0122 0C24 20.500 13 33 13 33z"/><circle cx="13" cy="12.500" r="4"/></svg>' }),
    }).addTo(map);
    this.input.value = r.name; this.clr.hidden = false;
    this.input.blur();
  },
  clear() {
    if (this.ctrl) { this.ctrl.abort(); this.ctrl = null; }
    this.input.value = ''; this.clr.hidden = true; this.results = []; this.hideList();
    if (this.marker) { this.marker.remove(); this.marker = null; }
    this.input.focus();
  },
};
Search.init();
