// Launch Signal's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked pre-token board, a live-token comparison table, filters, sorting, and a detail drawer
// per protocol with the model's arithmetic, its risk flags and its farm plan. No network: every byte
// it shows arrived in data.js. Deep links: #/p/<slug> opens a protocol, #/f/<category> filters the
// board, #/live opens the already-trading view.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, watchOnly: false, conf: 'all', tab: 'board', sort: 'implied', selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    if (days >= 30) return Math.round(days / 30) + 'mo';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return (Math.round(n * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0') + 'x'; }

  // The model, restated: the drawer recomputes a row's implied value from the snapshot figures and
  // the model's constants, and compares it with the number board.json carries, so a reader can see
  // the page and the board are the same arithmetic.
  function impliedOf(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.peer_multiple * row.growth_multiplier * row.maturity_multiplier * row.breadth_multiplier));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { if (r.category) seen[r.category] = true; });
    return Object.keys(seen).sort();
  }
  function chains() {
    var seen = {};
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.on_watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.conf !== 'all' && r.confidence !== state.conf) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var by = {
      implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d === null ? -999 : b.change_7d) - (a.change_7d === null ? -999 : a.change_7d); },
      age: function (a, b) { return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days); },
      rank: function (a, b) { return a.rank - b.rank; }
    };
    return rows.sort(by[state.sort] || by.implied);
  }

  function header() {
    var total = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var stat = function (v, k) { return el('div', { class: 'stat' }, el('div', { class: 'v num', text: v }), el('div', { class: 'k', text: k })); };
    return el('header', { class: 'masthead' },
      el('div', { class: 'masthead-in' },
        el('div', { class: 'kicker', text: 'Token launch radar · model ' + DATA.model_version }),
        el('h1', { class: 'title' }, 'Launch ', el('span', { class: 'sig', text: 'Signal' })),
        el('p', { class: 'lede', text: 'Protocols that record no token yet, ranked by what a launch could be worth if their record stayed as it is — and the farm plan for each. The watchlist is the floor: the board also sweeps the smaller pre-token protocols beneath it.' }),
        el('div', { class: 'stats' },
          stat(String(DATA.board_size), 'protocols ranked'),
          stat(DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'watchlist covered'),
          stat(fmtUsd(total), 'total implied value'),
          stat(fmtMult(DATA.peer_global), 'peer yardstick (median)'),
          stat(DATA.as_of, 'snapshot date')),
        el('div', { class: 'source-line', text: DATA.source + ' · floor $' + DATA.floor_usd.toLocaleString('en-US') + ' · no live data: this page renders the sealed snapshot only' })));
  }

  function modelStrip() {
    var top = DATA.peer_categories.filter(function (c) { return c.sample >= DATA.model.peer_min_sample; }).slice(0, 8);
    return el('section', { class: 'model-strip' },
      el('h2', { text: 'How a row is priced' }),
      el('p', { class: 'formula' }, 'implied value = TVL × ', el('b', { text: 'peer multiple' }), ' × ', el('b', { text: 'growth' }), ' × ', el('b', { text: 'maturity' }), ' × ', el('b', { text: 'breadth' })),
      el('p', { class: 'model-note', text: 'The peer multiple is measured, not chosen: the median market-cap / TVL of the ' + DATA.peer_global_sample + ' live tokens in this same snapshot, per category where at least ' + DATA.model.peer_min_sample + ' trade. Growth reads the 7-day TVL change, maturity rises over three tokenless years, breadth adds 5% per doubling of chains. An implied value is this board\u2019s own claim about a launch that may never happen — not a prediction, and not make.fun\u2019s.' }),
      el('div', { class: 'peer-table' }, top.map(function (c) {
        return el('span', null, el('b', { text: c.category }), ' ' + fmtMult(c.multiple) + ' · n=' + c.sample);
      })));
  }

  function toolbar() {
    var catSel = el('select', { 'aria-label': 'Category', onchange: function () { state.category = catSel.value; render(); } },
      el('option', { value: 'all', text: 'All categories' }),
      categories().map(function (c) { return el('option', { value: c, text: c, selected: state.category === c ? 'selected' : null }); }));
    var chainSel = el('select', { 'aria-label': 'Chain', onchange: function () { state.chain = chainSel.value; render(); } },
      el('option', { value: 'all', text: 'All chains' }),
      chains().map(function (c) { return el('option', { value: c, text: c, selected: state.chain === c ? 'selected' : null }); }));
    var tvlSel = el('select', { 'aria-label': 'Minimum TVL', onchange: function () { state.minTvl = Number(tvlSel.value); render(); } },
      [['0', 'Any TVL'], ['10000000', 'TVL ≥ $10M'], ['50000000', 'TVL ≥ $50M (floor)'], ['250000000', 'TVL ≥ $250M'], ['1000000000', 'TVL ≥ $1B']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: String(state.minTvl) === o[0] ? 'selected' : null });
      }));
    var confSel = el('select', { 'aria-label': 'Confidence', onchange: function () { state.conf = confSel.value; render(); } },
      [['all', 'Any confidence'], ['high', 'High confidence'], ['medium', 'Medium confidence'], ['low', 'Low confidence']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: state.conf === o[0] ? 'selected' : null });
      }));
    var sortSel = el('select', { 'aria-label': 'Sort', onchange: function () { state.sort = sortSel.value; render(); } },
      [['implied', 'Sort: implied value'], ['rank', 'Sort: board rank'], ['tvl', 'Sort: TVL'], ['growth', 'Sort: 7d change'], ['age', 'Sort: age']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: state.sort === o[0] ? 'selected' : null });
      }));
    var search = el('input', { type: 'search', placeholder: 'Search name, slug, category…', value: state.q, 'aria-label': 'Search',
      oninput: function () { state.q = search.value; renderTableOnly(); } });
    var watch = el('input', { type: 'checkbox', onchange: function () { state.watchOnly = watch.checked; render(); } });
    if (state.watchOnly) watch.setAttribute('checked', 'checked');
    return el('div', { class: 'toolbar' }, search, catSel, chainSel, tvlSel, confSel, sortSel,
      el('label', { class: 'check' }, watch, ' Watchlist only'));
  }

  function tabs() {
    var b = el('button', { class: 'tab', 'aria-selected': state.tab === 'board' ? 'true' : 'false', text: 'Pre-token board (' + DATA.board_size + ')',
      onclick: function () { state.tab = 'board'; render(); } });
    var l = el('button', { class: 'tab', 'aria-selected': state.tab === 'live' ? 'true' : 'false', text: 'Already trading (' + DATA.live_size + ')',
      onclick: function () { state.tab = 'live'; setHash('/live'); render(); } });
    return el('div', { class: 'tabs' }, b, l);
  }

  function boardTable(rows) {
    if (rows.length === 0) return el('div', { class: 'empty', text: 'No protocol matches this filter. Loosen it — the radar sweeps ' + DATA.board_size + ' pre-token protocols.' });
    var head = el('tr', null,
      el('th', { text: '#' }), el('th', { text: 'Protocol' }), el('th', { class: 'r', text: 'TVL' }),
      el('th', { class: 'r', text: '7d' }), el('th', { class: 'r hide-s', text: 'Age' }),
      el('th', { class: 'hide-s', text: 'Chains' }), el('th', { class: 'r', text: 'Implied value' }),
      el('th', { text: 'Confidence' }), el('th', { class: 'r', text: 'Flags' }));
    var body = rows.map(function (r) {
      var delta = r.change_7d === null ? el('span', { text: 'n/a' })
        : el('span', { class: r.change_7d >= 0 ? 'delta-pos' : 'delta-neg', text: fmtPct(r.change_7d) });
      return el('tr', { onclick: function () { openDetail(r.slug); } },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', { class: 'proto' },
          el('span', { class: 'name', text: r.name }),
          r.on_watchlist ? el('span', { class: 'badge', text: 'WATCHLIST' }) : el('span', { class: 'badge early', text: 'EARLY' }),
          el('div', { class: 'sub', text: (r.category || 'Uncategorised') + ' · peer ' + fmtMult(r.peer_multiple) })),
        el('td', { class: 'r num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'r num' }, delta),
        el('td', { class: 'r num hide-s', text: fmtAge(r.age_days) }),
        el('td', { class: 'chains-cell hide-s', text: r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') }),
        el('td', { class: 'implied r', text: fmtUsd(r.implied_value_usd) }),
        el('td', null, el('span', { class: 'conf ' + r.confidence }, el('span', { class: 'dot' }), r.confidence)),
        el('td', { class: 'r' }, el('span', { class: 'flags-n' + (r.risk_flags.length ? '' : ' none'), text: r.risk_flags.length ? String(r.risk_flags.length) : '—' })));
    });
    return el('table', { class: 'board' }, el('thead', null, head), el('tbody', null, body));
  }

  function liveTable() {
    var head = el('tr', null,
      el('th', { text: 'Protocol' }), el('th', { class: 'r', text: 'Market cap' }), el('th', { class: 'r', text: 'TVL' }),
      el('th', { class: 'r', text: 'Value / TVL' }), el('th', { class: 'r', text: '7d' }), el('th', { class: 'hide-s', text: 'Chains' }));
    var body = DATA.live.map(function (r) {
      var delta = r.change_7d === null ? el('span', { text: 'n/a' })
        : el('span', { class: r.change_7d >= 0 ? 'delta-pos' : 'delta-neg', text: fmtPct(r.change_7d) });
      return el('tr', null,
        el('td', { class: 'proto' }, el('span', { class: 'name', text: r.name }),
          el('div', { class: 'sub', text: r.category || 'Uncategorised' })),
        el('td', { class: 'r num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'r num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'r num', text: r.value_per_tvl === null ? 'n/a' : fmtMult(r.value_per_tvl) }),
        el('td', { class: 'r num' }, delta),
        el('td', { class: 'chains-cell hide-s', text: r.chains.slice(0, 3).join(', ') }));
    });
    return el('div', null,
      el('p', { class: 'live-note', text: 'These protocols already have a token: the market prices them, so no model here ranks them. They are shown because they are the yardstick — the board\u2019s peer multiples are the medians of this set\u2019s market-cap / TVL ratios, per category.' }),
      el('table', { class: 'board' }, el('thead', null, head), el('tbody', null, body)));
  }

  function factor(label, mult, widthPct) {
    return el('div', { class: 'factor' },
      el('span', { class: 'fk', text: label }),
      el('span', { class: 'bar' }, el('i', { style: 'width:' + Math.max(4, Math.min(100, widthPct)) + '%' })),
      el('span', { class: 'fv', text: fmtMult(mult) }));
  }

  function detail(row) {
    var recomputed = impliedOf(row);
    var kv = function (k, v) { return el('div', { class: 'cell' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })); };
    var drawer = el('aside', { class: 'drawer', 'aria-label': row.name + ' detail' },
      el('button', { class: 'close', text: '×', 'aria-label': 'Close', onclick: closeDetail }),
      el('div', { class: 'kicker', text: 'Rank #' + row.rank + ' of ' + DATA.board_size + (row.on_watchlist ? ' · on the watchlist' : ' · early radar, below the floor') }),
      el('h2', { text: row.name }),
      el('p', { class: 'd-sub', text: (row.category || 'Uncategorised') + ' · records no token · tracked since ' + (row.listed_at || 'an unrecorded date') }),
      el('div', { class: 'big-implied' },
        el('div', { class: 'k', text: 'Implied value if it launched on this record' }),
        el('div', { class: 'v', text: fmtUsd(row.implied_value_usd) })),
      el('div', { class: 'factors' },
        factor('Peer multiple', row.peer_multiple, row.peer_multiple * 40),
        factor('Growth (7d)', row.growth_multiplier, (row.growth_multiplier - 0.6) * 100),
        factor('Maturity', row.maturity_multiplier, row.maturity_multiplier * 100),
        factor('Breadth', row.breadth_multiplier, (row.breadth_multiplier - 1) * 400)),
      el('div', { class: 'check-line', text: recomputed === row.implied_value_usd
        ? '✓ recomputed here from the snapshot figures: ' + fmtUsd(recomputed) + ' — matches board.json'
        : 'recomputed here: ' + fmtUsd(recomputed) }),
      el('div', { class: 'kv' },
        kv('TVL', fmtUsd(row.tvl_usd)),
        kv('7d TVL change', fmtPct(row.change_7d)),
        kv('Age tracked', fmtAge(row.age_days) + (row.age_days !== null ? ' (' + row.age_days + 'd)' : '')),
        kv('Peer sample', row.peer_sample + ' live tokens'),
        kv('Confidence', row.confidence),
        kv('Chains', String(row.chains.length))),
      el('h3', { text: 'Networks' }),
      el('div', { class: 'chip-row' }, row.chains.map(function (c) { return el('span', { class: 'chip', text: c }); })),
      el('h3', { text: 'Risk flags' }),
      el('ul', { class: 'flags' }, row.risk_flags.length
        ? row.risk_flags.map(function (f) { return el('li', { text: f }); })
        : [el('li', { class: 'clean', text: 'No flags on this record: TVL steady, tracked over 90 days, more than one chain.' })]),
      el('h3', { text: 'Farm plan — what to do before any launch' }),
      el('ol', { class: 'plan' }, row.farm_steps.map(function (s) { return el('li', { text: s }); })),
      el('p', { class: 'model-note', text: 'The plan assumes a token may come and may not: every step is a normal use of the protocol, sized so that being wrong costs the gas and the time, not the capital.' }));
    return el('div', null, el('div', { class: 'scrim', onclick: closeDetail }), drawer);
  }

  function setHash(h) {
    try { history.replaceState(null, '', '#' + h); } catch (e) { /* file URLs in some browsers */ }
  }
  function openDetail(slug) {
    state.selected = slug;
    setHash('/p/' + slug);
    render();
  }
  function closeDetail() {
    state.selected = null;
    setHash(state.tab === 'live' ? '/live' : '/');
    render();
  }

  var tableHost = null;
  function renderTableOnly() {
    if (!tableHost || state.tab !== 'board') { render(); return; }
    var rows = visibleRows();
    var fresh = boardTable(rows);
    tableHost.replaceChildren(fresh);
    var count = document.getElementById('count-line');
    if (count) count.textContent = rows.length + ' of ' + DATA.board_size + ' protocols shown · click a row for its detail and farm plan';
  }

  function render() {
    app.setAttribute('aria-busy', 'false');
    var selected = state.selected ? DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] : null;
    var children = [header(), el('div', { class: 'wrap' }, modelStrip(), tabs())];
    var wrap = children[1];
    if (state.tab === 'board') {
      var rows = visibleRows();
      tableHost = el('div', null, boardTable(rows));
      wrap.appendChild(toolbar());
      wrap.appendChild(el('div', { class: 'count-line', id: 'count-line', text: rows.length + ' of ' + DATA.board_size + ' protocols shown · click a row for its detail and farm plan' }));
      wrap.appendChild(tableHost);
    } else {
      tableHost = null;
      wrap.appendChild(liveTable());
    }
    wrap.appendChild(el('footer', { class: 'colophon' },
      el('p', { text: 'Launch Signal · model ' + DATA.model_version + ' · an implied value is this board\u2019s own claim from the snapshot\u2019s figures, never a prediction that a token will be issued.' }),
      el('p', { text: DATA.source })));
    app.replaceChildren.apply(app, children);
    if (selected) app.appendChild(detail(selected));
  }

  // Deep links: a screenshot, a shared link or a refresh can land on a protocol, a filter or the
  // live view directly.
  (function fromHash() {
    var h = (location.hash || '').replace(/^#/, '');
    var m = h.match(/^\/p\/(.+)$/);
    if (m) { state.selected = decodeURIComponent(m[1]); return; }
    m = h.match(/^\/f\/(.+)$/);
    if (m) { state.category = decodeURIComponent(m[1]); return; }
    if (h === '/live') state.tab = 'live';
  })();

  render();
})();
