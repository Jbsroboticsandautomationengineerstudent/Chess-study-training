// ==UserScript==
// @name         Stockfish 19 / Maia 3 Chess Board Assistant
// @namespace    https://github.com/Jbsroboticsandautomationengineerstudent/Chess-study-training
// @version      1.5.0
// @description  Switchable Stockfish 19 and Maia 3 board analysis
// @match        https://www.chess.com/*
// @match        https://chess.com/*
// @run-at       document-idle
// @inject-into  content
// @require      https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.min.js
// @connect      unpkg.com
// @connect      huggingface.co
// @connect      cas-bridge.xethub.hf.co
// @connect      cdn-lfs.hf.co
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(async () => {
  'use strict';

  if (window.top !== window || document.getElementById('maia-web-panel')) return;
  const ENGINE_BASE = 'https://unpkg.com/stockfish@19.0.1/bin/';
  const ENGINE_SCRIPT = `${ENGINE_BASE}stockfish-19-single.js`;
  const ENGINE_WASM = `${ENGINE_BASE}stockfish-19-single.wasm`;
  const ENGINE_CACHE = 'stockfish-19-assets-v1';
  const MAIA_MODEL_URL = 'https://huggingface.co/cstr/maia3-onnx-int32/resolve/main/maia3_79m_int32.onnx';
  const MAIA_MODEL_MIN_BYTES = 300_000_000;
  const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
  const RESEARCH_DEPTH = 18;
  const REVIEW_PALETTE = {
    Brilliant: {color: '#28c9bd', icon: '!!'}, Great: {color: '#6f9fca', icon: '!'},
    Best: {color: '#78b847', icon: '★'}, Excellent: {color: '#93bf5c', icon: '+'},
    Good: {color: '#76ae70', icon: '✓'}, Book: {color: '#b7976e', icon: 'B'},
    Inaccuracy: {color: '#e2c145', icon: '?!'}, Mistake: {color: '#e69b58', icon: '?'},
    Miss: {color: '#dc6968', icon: '×'}, Blunder: {color: '#d6534f', icon: '??'}
  };
  const REVIEW_RULES = {
    Brilliant: 'Unavailable: needs validated sacrifice analysis',
    Great: 'Best move; at least 150 cp ahead of the second choice, which is below -100 cp',
    Best: 'Evaluation loss up to 10 cp', Excellent: 'Evaluation loss up to 35 cp',
    Good: 'Evaluation loss up to 80 cp', Book: 'Unavailable: needs an opening book',
    Inaccuracy: 'Evaluation loss up to 160 cp', Mistake: 'Evaluation loss up to 300 cp',
    Miss: 'A winning +150 cp position falls to 0 or worse after a 160-300 cp loss',
    Blunder: 'Evaluation loss greater than 300 cp'
  };
  const ChessClass = typeof Chess !== 'undefined' ? Chess : window.Chess;
  const ortApi = typeof ort !== 'undefined' ? ort : window.ort;
  if (!ChessClass) {
    console.error('[Stockfish 19] chess.js did not load. Check the userscript manager and CDN access.');
    return;
  }

  function readSetting(name) {
    const key = `chess-assistant-${name}`;
    try {
      if (typeof GM_getValue === 'function') {
        const value = GM_getValue(key, null);
        if (typeof value === 'string') return value;
      }
    } catch { /* Use page storage if the manager has no value store. */ }
    try { return localStorage.getItem(key); }
    catch { return null; }
  }
  function saveSetting(name, value) {
    const key = `chess-assistant-${name}`;
    try {
      if (typeof GM_setValue === 'function')
        Promise.resolve(GM_setValue(key, String(value))).catch(() => {});
    } catch { /* Keep using page storage. */ }
    try { localStorage.setItem(key, String(value)); }
    catch { /* Private browsing may disable page storage. */ }
  }

  const START_PLACEMENT = new ChessClass().fen().split(' ')[0];
  let board = null;
  let game = null;
  let worker = null;
  let workerUrl = '';
  let wasmBlobUrl = '';
  let engineReady = false;
  let engineStarting = false;
  let engineError = '';
  let engineCached = false;
  let cacheAvailable = true;
  let engineMode = readSetting('engine') === 'maia' ? 'maia' : 'stockfish';
  let engineGeneration = 0;
  let maiaGeneration = 0;
  let maiaSession = null;
  let maiaLoading = null;
  let maiaDownloadController = null;
  let maiaRun = null;
  let maiaError = '';
  let maiaBackend = '';
  let maiaRating = Math.max(600, Math.min(2600, Number(readSetting('maia-rating') ?? 2600) || 2600));
  let inferenceId = 0;
  let depth = Math.max(10, Math.min(25, Number(readSetting('stockfish-depth') ?? 11) || 11));
  let autoPlay = readSetting('maia-autoplay') === 'true';
  let autoNextBot = readSetting('maia-auto-next-bot') === 'true';
  let autoPlayedFen = '';
  let autoPlayTimer = 0;
  let autoPlayToken = 0;
  let nextBotTimer = 0;
  let nextBotAttempted = false;
  let activeSearch = null;
  let pendingSearch = null;
  let researchJob = null;
  let researchResult = null;
  let reviewSignature = '';
  let lastStudyRoute = null;
  let liveReview = [];
  let livePending = null;
  let lastSearchResult = null;
  let showResearchResult = false;
  let openingName = '';
  let lastFen = '';
  let lastBoard = '';
  let missedBoard = '';
  let missedCount = 0;
  let scanTimer = 0;
  let flipOverride = readSetting('flip') === 'true';
  let shownMoves = [];
  let shownValue = null;
  let streamerMode = false;
  let streamPopup = null;
  let streamChannel = null;
  let popupChannel = null;
  let lastStreamSignature = '';
  let lastBoardOrientation = false;
  let skinBoard = null;
  let skinCheckedAt = 0;
  let boardSkin = {light: '#eeeed2', dark: '#769656', pieces: {}};
  const seenPositions = new Map();

  const style = document.createElement('style');
  style.textContent = `
    #maia-web-panel{position:fixed;top:90px;right:16px;z-index:2147483646;
      width:min(320px,calc(100vw - 24px));box-sizing:border-box;background:#15212c;
      color:#f7f9fb;border:1px solid #496276;border-radius:12px;
      box-shadow:0 14px 36px #0009;font:13px/1.4 system-ui,-apple-system,sans-serif}
    #maia-web-panel *{box-sizing:border-box}
    #maia-web-head{padding:11px 13px;background:linear-gradient(115deg,#253d4e,#1c2c3c);
      border-bottom:2px solid #37b9aa;border-radius:11px 11px 0 0;letter-spacing:.02em;
      font-weight:700;cursor:grab;touch-action:none;user-select:none;display:flex;justify-content:space-between}
    #maia-web-panel .body{padding:10px 12px}
    #maia-web-panel .review-card{margin:8px 0;padding:9px;border:1px solid #50657b;border-radius:8px;background:#213144}
    #maia-web-panel .review-card strong{font-size:12px;letter-spacing:.02em}
    #maia-web-panel .review-scores{display:flex;justify-content:space-between;gap:8px;margin-top:5px;font-variant-numeric:tabular-nums}
    #maia-web-review-details,#maia-web-review-current{font-size:11px;color:#c8d8e6;margin-top:4px}
    #maia-web-panel .review-legend{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
    #maia-web-panel .review-chip{font-size:10px;padding:2px 5px;border-radius:4px;color:#0e1921;font-weight:700}
    #maia-web-panel .review-chip[aria-disabled="true"]{opacity:.45}
    #maia-web-board-review{position:fixed;z-index:2147483644;pointer-events:none;box-sizing:border-box;
      padding:6px 10px;border:1px solid #59708a;border-radius:7px;background:#17212de9;color:#f7f9fb;
      font:600 12px/1.3 system-ui,-apple-system,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      box-shadow:0 3px 12px #0006}
    #maia-web-panel .row{display:flex;align-items:center;gap:7px;margin-bottom:7px}
    #maia-web-panel [hidden]{display:none!important}
    #maia-web-panel select,#maia-web-panel input,#maia-web-panel button{
      color:#fff;background:#33485d;border:1px solid #708296;border-radius:5px;padding:4px 6px;font:inherit}
    #maia-web-panel button{cursor:pointer}
    #maia-web-panel button:hover{border-color:#79adbb;background:#3b5668}
    #maia-web-panel button:focus-visible,#maia-web-panel select:focus-visible,
    #maia-web-panel input:focus-visible{outline:2px solid #55d7c4;outline-offset:2px}
    #maia-web-depth,#maia-web-rating{width:auto;min-width:0;flex:1;accent-color:#24dc83}
    #maia-web-depth-label,#maia-web-rating-label{min-width:25px;text-align:right;font-variant-numeric:tabular-nums}
    #maia-web-panel input{width:100%;font:11px/1.4 ui-monospace,monospace}
    #maia-web-status{color:#c6d5e4;min-height:32px;margin:5px 0;white-space:pre-wrap}
    #maia-web-opening{color:#a9dbc2;font-size:12px;min-height:18px;margin:3px 0}
    #maia-web-moves{margin:6px 0 8px;padding-left:21px;font:14px/1.6 ui-monospace,monospace}
    #maia-web-fen{overflow-wrap:anywhere;color:#a9b9c9;font:10px/1.3 ui-monospace,monospace}
    #maia-web-value{margin:7px 0 9px}
    #maia-web-value-label{display:flex;justify-content:space-between;margin-bottom:3px;color:#dbe7f1;font-size:11px}
    #maia-web-value-bar{display:flex;height:12px;overflow:hidden;border:1px solid #708296;border-radius:5px;background:#33485d}
    #maia-web-value-bar span{height:100%;min-width:0}
    #maia-web-white{background:#f5f5ed} #maia-web-draw{background:#cfb951} #maia-web-black{background:#242b35}
    #maia-web-arrow{position:fixed;z-index:2147483645;pointer-events:none;overflow:visible}
    #maia-web-research{margin:8px 0 0;border-top:1px solid #50657b;padding-top:8px}
    #maia-web-research summary{cursor:pointer;font-weight:700}
    #maia-web-research textarea{width:100%;min-height:85px;margin:7px 0;color:#fff;background:#33485d;border:1px solid #708296;border-radius:5px;font:11px/1.4 ui-monospace,monospace}
    #maia-web-research .row input{flex:1;width:0;min-width:0}
    #maia-web-research .row select{max-width:95px}
    #maia-web-research-note{font-size:11px;color:#c6d5e4;white-space:pre-wrap}
    @media(max-width:600px){#maia-web-panel{top:68px;right:8px}}
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'maia-web-panel';
  panel.innerHTML = `
    <div id="maia-web-head"><span>Stockfish 19</span><span>drag</span></div>
    <div class="body">
      <div class="row"><button id="maia-web-human" title="Switch between Maia 3 and Stockfish 19">Enable human moves: OFF</button></div>
      <div class="row" id="maia-web-stockfish-settings"><label for="maia-web-depth">Depth</label><input id="maia-web-depth" type="range" min="10" max="25" value="11"><span id="maia-web-depth-label">11</span></div>
      <div class="row" id="maia-web-stockfish-strength" title="Full single-threaded build; no strength handicap. Elo is not fixed by depth.">Full build · Max skill · Elo varies</div>
      <div class="row" id="maia-web-maia-settings" hidden><label for="maia-web-rating">Maia rating</label><input id="maia-web-rating" type="range" min="600" max="2600" step="100" value="2600"><span id="maia-web-rating-label">2600</span></div>
      <div class="row" id="maia-web-maia-note" hidden>Maia 79M · one prediction pass; no search depth</div>
      <div class="row" id="maia-web-auto-row" hidden><button id="maia-web-autoplay">Auto-play Maia: OFF</button>
        <select id="maia-web-auto-side" aria-label="Side for Maia auto-play"><option value="bottom">Bottom side</option><option value="w">White</option><option value="b">Black</option></select></div>
      <div class="row" id="maia-web-next-row" hidden><button id="maia-web-next">Auto next bot game: OFF</button></div>
      <div class="row"><button id="maia-web-flip" title="Reverse arrow orientation">Flip</button></div>
      <div id="maia-web-status">Finding board…</div>
      <div id="maia-web-opening">Opening: —</div>
      <div id="maia-web-review-card" class="review-card" hidden><strong>Move review</strong>
        <div id="maia-web-review-scores" class="review-scores"></div>
        <div id="maia-web-review-details"></div>
        <div id="maia-web-review-current"></div><div id="maia-web-review-legend" class="review-legend"></div></div>
      <ol id="maia-web-moves"></ol>
      <div id="maia-web-value"><div id="maia-web-value-label"><span>White win —</span><span>Draw —</span><span>Black win —</span></div>
        <div id="maia-web-value-bar" role="img" aria-label="Estimated win probabilities"><span id="maia-web-white"></span><span id="maia-web-draw"></span><span id="maia-web-black"></span></div></div>
      <div class="row"><button id="maia-web-retry">Retry engine</button>
        <button id="maia-web-rescan">Rescan board</button></div>
      <div class="row"><button id="maia-web-streamer">Streamer Mode: OFF</button></div>
      <div class="row"><input id="maia-web-paste" placeholder="Paste full FEN if joining midgame" aria-label="Full FEN"></div>
      <div class="row"><button id="maia-web-use-fen">Use FEN</button></div>
      <div id="maia-web-fen"></div>
      <details id="maia-web-research"><summary>Post-game move research</summary>
        <textarea id="maia-web-pgn" placeholder="Paste a completed game's PGN"></textarea>
        <div class="row"><select id="maia-web-research-side" aria-label="Side to analyze"><option value="both">Both sides</option><option value="w">White moves</option><option value="b">Black moves</option></select>
          <input id="maia-web-s" type="number" min="0" step="any" placeholder="Fitted s" aria-label="Fitted sensitivity s">
          <input id="maia-web-c" type="number" min="0" step="any" placeholder="Fitted c" aria-label="Fitted consistency c"></div>
        <div class="row"><button id="maia-web-research-run">Analyze PGN</button><button id="maia-web-research-cancel" disabled>Cancel</button></div>
        <div class="row"><button id="maia-web-research-download" disabled>Download JSON</button></div>
        <div id="maia-web-research-note">Fixed depth 18; every legal move. Review accuracy is calculated from evaluation loss. Fitted s,c are required for move probabilities.</div>
      </details>
    </div>`;
  document.documentElement.appendChild(panel);
  const statusEl = panel.querySelector('#maia-web-status');
  const depthEl = panel.querySelector('#maia-web-depth');
  const depthLabelEl = panel.querySelector('#maia-web-depth-label');
  const humanButton = panel.querySelector('#maia-web-human');
  const ratingEl = panel.querySelector('#maia-web-rating');
  const ratingLabelEl = panel.querySelector('#maia-web-rating-label');
  const autoButton = panel.querySelector('#maia-web-autoplay');
  const nextButton = panel.querySelector('#maia-web-next');
  const autoSideEl = panel.querySelector('#maia-web-auto-side');
  const openingEl = panel.querySelector('#maia-web-opening');
  const movesEl = panel.querySelector('#maia-web-moves');
  const fenEl = panel.querySelector('#maia-web-fen');
  const researchNoteEl = panel.querySelector('#maia-web-research-note');
  const reviewCard = panel.querySelector('#maia-web-review-card');
  const reviewScores = panel.querySelector('#maia-web-review-scores');
  const reviewDetails = panel.querySelector('#maia-web-review-details');
  const reviewCurrent = panel.querySelector('#maia-web-review-current');
  const reviewLegend = panel.querySelector('#maia-web-review-legend');
  const valueLabels = panel.querySelectorAll('#maia-web-value-label span');
  const valueSegments = ['#maia-web-white', '#maia-web-draw', '#maia-web-black'].map(selector => panel.querySelector(selector));

  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.id = 'maia-web-arrow';
  arrow.setAttribute('viewBox', '0 0 100 100');
  document.documentElement.appendChild(arrow);
  arrow.style.display = 'none';
  const boardReview = document.createElement('div');
  boardReview.id = 'maia-web-board-review';
  boardReview.hidden = true;
  document.documentElement.appendChild(boardReview);
  const svgNS = 'http://www.w3.org/2000/svg';

  function setStatus(message) {
    const displayed = studyReviewPage() ? String(message).replace(/Stockfish 19|Stockfish/g, 'Precision search')
      .replace(/Maia 79M|Maia/g, 'Human model') : message;
    if (statusEl.textContent !== displayed) {
      statusEl.textContent = displayed;
      publishStreamState();
    }
  }
  function clearPrediction() {
    inferenceId++;
    clearTimeout(autoPlayTimer);
    autoPlayToken++;
    clearTimeout(nextBotTimer);
    nextBotTimer = 0;
    if (activeSearch && worker) {
      activeSearch.stale = true;
      worker.postMessage('stop');
    }
    pendingSearch = null;
    lastFen = '';
    movesEl.replaceChildren();
    shownMoves = [];
    shownValue = null;
    valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} —`; });
    valueSegments.forEach(segment => { segment.style.width = '0%'; });
    panel.querySelector('#maia-web-value-bar').setAttribute('aria-label', 'Win probabilities unavailable');
    arrow.replaceChildren();
    arrow.style.display = 'none';
    publishStreamState();
  }
  function keepArrowAligned() {
    alignBoardReview();
    if (streamerMode || !board || arrow.style.display === 'none') return;
    const r = board.getBoundingClientRect();
    arrow.style.left = `${r.left}px`;
    arrow.style.top = `${r.top}px`;
    arrow.style.width = `${r.width}px`;
    arrow.style.height = `${r.height}px`;
  }
  function isBlackView() {
    if (!board) return false;
    return boardViewBlack() !== flipOverride;
  }
  function boardViewBlack() {
    return Boolean(board?.closest('.flipped, .orientation-black, [data-orientation="black"]'));
  }
  function squarePoint(square, black = isBlackView()) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    return {x: (black ? 7 - file : file) * 12.5 + 6.25,
            y: (black ? rank : 7 - rank) * 12.5 + 6.25};
  }
  function paintMoveArrow(svg, doc, move, blackView) {
    const a = squarePoint(move.uci.slice(0, 2), blackView);
    const b = squarePoint(move.uci.slice(2, 4), blackView);
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!length) return false;
    const ux = dx / length, uy = dy / length;
    const endX = b.x - ux * 3.2, endY = b.y - uy * 3.2;
    const line = doc.createElementNS(svgNS, 'line');
    const color = move.color || '#00008A';
    for (const [name, value] of Object.entries({x1: a.x, y1: a.y, x2: endX, y2: endY, stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round'})) line.setAttribute(name, value);
    svg.appendChild(line);
    const tip = doc.createElementNS(svgNS, 'polygon');
    const wingX = -uy * 2.1, wingY = ux * 2.1;
    tip.setAttribute('points', `${b.x},${b.y} ${b.x - ux * 4.3 + wingX},${b.y - uy * 4.3 + wingY} ${b.x - ux * 4.3 - wingX},${b.y - uy * 4.3 - wingY}`);
    tip.setAttribute('fill', color);
    svg.appendChild(tip);
    if (move.icon) {
      const badge = doc.createElementNS(svgNS, 'circle');
      for (const [name, value] of Object.entries({cx: b.x, cy: b.y - 3.3, r: 2.5, fill: color}))
        badge.setAttribute(name, value);
      svg.appendChild(badge);
      const icon = doc.createElementNS(svgNS, 'text');
      for (const [name, value] of Object.entries({x: b.x, y: b.y - 2.25, 'text-anchor': 'middle',
        'font-size': move.icon.length > 1 ? 2.5 : 3.2, 'font-weight': 800, fill: '#fff'}))
        icon.setAttribute(name, value);
      icon.textContent = move.icon;
      svg.appendChild(icon);
    }
    const label = doc.createElementNS(svgNS, 'text');
    label.setAttribute('x', b.x);
    label.setAttribute('y', b.y + 4.6);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '3.1');
    label.setAttribute('font-weight', '700');
    label.setAttribute('font-family', 'system-ui,sans-serif');
    label.setAttribute('fill', '#fff');
    if (move.label) {
      const background = doc.createElementNS(svgNS, 'rect');
      for (const [name, value] of Object.entries({x: b.x - 5.5, y: b.y + 1.4,
        width: 11, height: 4.3, rx: 1, fill: '#10251b', opacity: 0.9}))
        background.setAttribute(name, value);
      svg.appendChild(background);
    }
    label.textContent = move.label || '';
    svg.appendChild(label);
    return true;
  }
  function visibleColor(color) {
    return Boolean(color && color !== 'transparent' &&
      !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color));
  }
  function captureBoardSkin() {
    if (!board) return boardSkin;
    if (board === skinBoard && Date.now() - skinCheckedAt < 1500) return boardSkin;
    skinBoard = board;
    skinCheckedAt = Date.now();
    const skin = {light: boardSkin.light, dark: boardSkin.dark, pieces: {}};
    for (const el of board.querySelectorAll('.piece')) {
      const code = [...el.classList].find(name => /^[wb][prnbqk]$/.test(name));
      if (!code || skin.pieces[code]) continue;
      let visual = null;
      for (const source of [el, el.firstElementChild].filter(Boolean)) {
        for (const pseudo of [null, '::before', '::after']) {
          let style;
          try { style = getComputedStyle(source, pseudo); }
          catch { continue; }
          const image = style.backgroundImage && style.backgroundImage !== 'none' ? style.backgroundImage : '';
          const maskValue = style.maskImage || style.webkitMaskImage;
          const mask = maskValue && maskValue !== 'none' ? maskValue : '';
          if (!image && !mask) continue;
          visual = {
            backgroundImage: image, backgroundSize: style.backgroundSize,
            backgroundPosition: style.backgroundPosition, backgroundRepeat: style.backgroundRepeat,
            maskImage: mask, maskSize: style.maskSize || style.webkitMaskSize,
            maskPosition: style.maskPosition || style.webkitMaskPosition,
            maskRepeat: style.maskRepeat || style.webkitMaskRepeat,
            backgroundColor: style.backgroundColor,
            color: style.color, filter: style.filter,
            sourceSize: source.getBoundingClientRect().width || el.getBoundingClientRect().width || board.getBoundingClientRect().width / 8
          };
          break;
        }
        if (visual) break;
      }
      if (!visual) {
        const image = el.querySelector('img');
        if (image?.currentSrc || image?.src) visual = {
          backgroundImage: `url("${image.currentSrc || image.src}")`, backgroundSize: '100% 100%',
          backgroundPosition: 'center', backgroundRepeat: 'no-repeat', maskImage: '',
          filter: 'none', sourceSize: el.getBoundingClientRect().width || board.getBoundingClientRect().width / 8
        };
      }
      if (visual) skin.pieces[code] = visual;
    }
    const squareColors = {light: new Map(), dark: new Map()};
    for (const el of board.querySelectorAll('.square, .light, .dark, [class*="square-"]')) {
      if (el.classList.contains('piece') || el.closest('.piece')) continue;
      let kind = el.classList.contains('light') ? 'light' : el.classList.contains('dark') ? 'dark' : null;
      if (!kind) {
        const square = [...el.classList].map(name => /^square-([1-8])([1-8])$/.exec(name)).find(Boolean);
        if (square) kind = (Number(square[1]) + Number(square[2])) % 2 ? 'light' : 'dark';
      }
      if (!kind) continue;
      const color = getComputedStyle(el).backgroundColor;
      if (visibleColor(color)) squareColors[kind].set(color, (squareColors[kind].get(color) || 0) + 1);
    }
    for (const kind of ['light', 'dark']) {
      const colors = [...squareColors[kind]];
      if (colors.length) skin[kind] = colors.sort((a, b) => b[1] - a[1])[0][0];
    }
    const boardStyle = getComputedStyle(board);
    for (const el of (squareColors.light.size && squareColors.dark.size ? [] :
      [board, board.querySelector('wc-chess-board, chess-board')].filter(Boolean))) {
      for (const pseudo of [null, '::before']) {
        let style;
        try { style = getComputedStyle(el, pseudo); }
        catch { continue; }
        if (!style.backgroundImage || style.backgroundImage === 'none') continue;
        skin.boardBackgroundImage = style.backgroundImage;
        skin.boardBackgroundSize = style.backgroundSize;
        skin.boardBackgroundPosition = style.backgroundPosition;
        skin.sourceBoardSize = el.getBoundingClientRect().width;
        break;
      }
      if (skin.boardBackgroundImage) break;
    }
    const variables = {
      light: ['--light-square-color', '--board-color-light', '--board-light', '--light-square', '--color-board-light'],
      dark: ['--dark-square-color', '--board-color-dark', '--board-dark', '--dark-square', '--color-board-dark']
    };
    for (const kind of ['light', 'dark']) {
      for (const name of variables[kind]) {
        const color = boardStyle.getPropertyValue(name).trim();
        if (visibleColor(color) && CSS.supports('color', color)) { skin[kind] = color; break; }
      }
    }
    boardSkin = skin;
    return skin;
  }
  function scaleCssPixels(value, factor) {
    return String(value || '').replace(/(-?\d+(?:\.\d+)?)px/g,
      (_, size) => `${(Number(size) * factor).toFixed(2)}px`);
  }
  function renderMiniBoard(doc, fen, blackView, move, skin, recentMove = null) {
    const pieces = new Map();
    const ranks = fen?.split(' ')[0]?.split('/') || [];
    if (ranks.length === 8) {
      ranks.forEach((rank, row) => {
        let file = 0;
        for (const symbol of rank) {
          if (/^[1-8]$/.test(symbol)) file += Number(symbol);
          else pieces.set(`${file++}${8 - row}`, symbol);
        }
      });
    }
    const glyph = {K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
      k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'};
    const miniBoard = doc.getElementById('mini-board');
    miniBoard.style.backgroundImage = skin?.boardBackgroundImage || '';
    miniBoard.style.backgroundSize = skin?.boardBackgroundImage ?
      (skin.boardBackgroundSize === 'auto' || skin.boardBackgroundSize === 'auto auto' ?
        '100% 100%' : scaleCssPixels(skin.boardBackgroundSize, 240 / (skin.sourceBoardSize || 240))) : '';
    miniBoard.style.backgroundPosition = skin?.boardBackgroundImage ?
      scaleCssPixels(skin.boardBackgroundPosition, 240 / (skin.sourceBoardSize || 240)) : '';
    doc.querySelectorAll('#mini-board .square').forEach((cell, index) => {
      const row = Math.floor(index / 8), col = index % 8;
      const file = blackView ? 7 - col : col;
      const rank = blackView ? row + 1 : 8 - row;
      const piece = pieces.get(`${file}${rank}`);
      const symbol = cell.firstElementChild;
      cell.style.backgroundColor = skin?.boardBackgroundImage ? 'transparent' :
        (row + col) % 2 ? skin?.dark || '#769656' : skin?.light || '#eeeed2';
      symbol.removeAttribute('style');
      const code = piece ? `${piece === piece.toUpperCase() ? 'w' : 'b'}${piece.toLowerCase()}` : '';
      const visual = skin?.pieces?.[code];
      if (visual) {
        const scale = 30 / (visual.sourceSize || 30);
        symbol.textContent = '';
        symbol.className = '';
        symbol.style.width = '100%';
        symbol.style.height = '100%';
        symbol.style.backgroundImage = visual.backgroundImage;
        symbol.style.backgroundSize = scaleCssPixels(visual.backgroundSize, scale);
        symbol.style.backgroundPosition = scaleCssPixels(visual.backgroundPosition, scale);
        symbol.style.backgroundRepeat = visual.backgroundRepeat;
        symbol.style.maskImage = visual.maskImage;
        symbol.style.webkitMaskImage = visual.maskImage;
        symbol.style.maskSize = scaleCssPixels(visual.maskSize, scale);
        symbol.style.webkitMaskSize = scaleCssPixels(visual.maskSize, scale);
        symbol.style.maskPosition = scaleCssPixels(visual.maskPosition, scale);
        symbol.style.webkitMaskPosition = scaleCssPixels(visual.maskPosition, scale);
        symbol.style.maskRepeat = visual.maskRepeat;
        symbol.style.webkitMaskRepeat = visual.maskRepeat;
        symbol.style.backgroundColor = visual.maskImage ? (visibleColor(visual.backgroundColor) ? visual.backgroundColor : visual.color) : '';
        symbol.style.filter = visual.filter;
      } else {
        symbol.textContent = glyph[piece] || '';
        symbol.className = piece ? (piece === piece.toUpperCase() ? 'white-piece' : 'black-piece') : '';
      }
    });
    const miniArrow = doc.getElementById('mini-arrow');
    miniArrow.replaceChildren();
    if (ranks.length === 8 && move) paintMoveArrow(miniArrow, doc, move, blackView);
    if (ranks.length === 8 && recentMove && recentMove.uci !== move?.uci)
      paintMoveArrow(miniArrow, doc, recentMove, blackView);
  }
  function drawArrows(moves = shownMoves) {
    if (streamerMode) {
      arrow.replaceChildren();
      arrow.style.display = 'none';
      return;
    }
    arrow.replaceChildren();
    const move = reviewMoveForBoard() || moves[0];
    const recent = botGamePage() ? liveReview[liveReview.length - 1] : null;
    let drawn = board && move ? paintMoveArrow(arrow, document, move, isBlackView()) : false;
    if (board && recent?.review && recent.postFen === game?.fen() && recent.played !== move?.uci) {
      const visual = REVIEW_PALETTE[recent.review.category];
      drawn = paintMoveArrow(arrow, document, {uci: recent.played, color: visual.color,
        icon: visual.icon, label: `${recent.review.accuracy.toFixed(0)}%`}, isBlackView()) || drawn;
    }
    if (!drawn) { arrow.style.display = 'none'; return; }
    arrow.style.display = 'block';
    keepArrowAligned();
  }
  function autoPlayablePage() {
    return /^\/(?:play|game)\//.test(location.pathname);
  }
  function botGamePage() {
    return /^\/play\/computer(?:\/|$)/.test(location.pathname);
  }
  function botThinkingDelay() {
    if (!botGamePage()) return 0;
    // A bounded illustrative clock density: t0 + lognormal noise. Its parameters
    // are not fitted to human games, so this is a bot-game pace control only.
    const choices = Math.min(40, game?.moves().length || 20);
    const displayedProbability = parseFloat(shownMoves[0]?.label);
    const probability = Number.isFinite(displayedProbability)
      ? Math.max(0, Math.min(1, displayedProbability / 100)) : 0.5;
    const median = 1800 + choices * 35 + (1 - probability) * 1000;
    const u = Math.max(Number.EPSILON, Math.random());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    return Math.round(Math.max(1800, Math.min(7500, 700 + median * Math.exp(0.3 * z))));
  }
  function autoSide() {
    return autoSideEl.value === 'bottom' ? (isBlackView() ? 'b' : 'w') : autoSideEl.value;
  }
  function boardTarget(square) {
    if (!board?.isConnected) return false;
    const point = squarePoint(square, isBlackView());
    const rect = board.getBoundingClientRect();
    const x = rect.left + rect.width * point.x / 100;
    const y = rect.top + rect.height * point.y / 100;
    const target = document.elementFromPoint(x, y);
    return target && board.contains(target) ? {target, x, y} : null;
  }
  function boardEvent(position, type, pressed) {
    const options = {bubbles: true, cancelable: true, composed: true,
      clientX: position.x, clientY: position.y, button: 0, buttons: pressed ? 1 : 0};
    if (typeof PointerEvent === 'function')
      position.target.dispatchEvent(new PointerEvent(`pointer${type}`, {...options,
        pointerId: 1, pointerType: 'mouse', isPrimary: true}));
    position.target.dispatchEvent(new MouseEvent(`mouse${type}`, options));
  }
  function clickBoardSquare(square) {
    const position = boardTarget(square);
    if (!position) return false;
    boardEvent(position, 'down', true);
    boardEvent(position, 'up', false);
    position.target.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true,
      composed: true, clientX: position.x, clientY: position.y, button: 0}));
    return true;
  }
  function dragBoardMove(uci) {
    const from = boardTarget(uci.slice(0, 2));
    const to = boardTarget(uci.slice(2, 4));
    if (!from || !to) return false;
    boardEvent(from, 'down', true);
    boardEvent(to, 'move', true);
    boardEvent(to, 'up', false);
    return true;
  }
  function choosePromotion(uci) {
    if (uci.length !== 5) return;
    const code = `${autoSide()}${uci[4]}`;
    for (const element of document.querySelectorAll('.promotion-piece, .promotion-window .piece, .promotion-choices .piece')) {
      if (!element.classList.contains(code) || !element.getClientRects().length) continue;
      element.click();
      return;
    }
  }
  function maybeAutoPlay(fen, uci) {
    if (engineMode !== 'maia' || !autoPlay || !autoPlayablePage() || researchJob ||
        activeSearch || pendingSearch || !board ||
        game?.turn() !== autoSide() || autoPlayedFen === fen) return;
    autoPlayedFen = fen; // One attempt per position, even if the site ignores synthetic events.
    const delay = botThinkingDelay();
    const token = ++autoPlayToken;
    if (delay) setStatus(`Maia move ready · bot pace ${(delay / 1000).toFixed(1)}s`);
    clearTimeout(autoPlayTimer);
    autoPlayTimer = setTimeout(() => {
      autoPlayTimer = 0;
      if (token !== autoPlayToken || engineMode !== 'maia' || !autoPlay || !autoPlayablePage() ||
          researchJob || game?.fen() !== fen ||
          shownMoves[0]?.uci !== uci || !board?.isConnected) return;
      const moved = clickBoardSquare(uci.slice(0, 2)) && clickBoardSquare(uci.slice(2, 4));
      if (!moved) { setStatus('Auto-play could not reach the board. Move manually.'); return; }
      if (uci.length === 5) setTimeout(() => choosePromotion(uci), 50);
      setTimeout(() => {
        if (engineMode === 'maia' && autoPlay && autoPlayablePage() && game?.fen() === fen &&
            piecesFrom(board) === fen.split(' ')[0]) {
          dragBoardMove(uci);
          if (uci.length === 5) setTimeout(() => choosePromotion(uci), 50);
        }
      }, 450);
      setTimeout(() => {
        scan();
        if (engineMode === 'maia' && autoPlay && game?.fen() === fen)
          setStatus('Chess.com did not accept the automatic move. Move manually.');
      }, 1200);
    }, delay);
  }
  function visibleBotResult() {
    const selectors = '[data-cy*="game-over"], [data-testid*="game-over"], [class*="game-over"], [class*="gameOver"]';
    return Array.from(document.querySelectorAll(selectors)).some(el => el.getClientRects().length &&
      getComputedStyle(el).visibility !== 'hidden');
  }
  function nextBotGameButton() {
    const label = /^(?:(?:new|next)(?:\s+(?:bot\s+)?game)?(?:\s+\d+\s*(?:s|sec|secs|seconds?|min|mins|minutes?))?|play again|rematch)$/i;
    for (const el of document.querySelectorAll('button, [role="button"], a, [data-cy*="new-game"], [class*="new-game"], [class*="newGame"]')) {
      if (el.closest('#maia-web-panel') || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
          !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
      const text = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (label.test(text)) return el;
    }
    return null;
  }
  function maybeStartNextBotGame() {
    if (engineMode !== 'maia' || !autoPlay || !autoNextBot || !botGamePage()) {
      clearTimeout(nextBotTimer);
      nextBotTimer = 0;
      return;
    }
    const finished = Boolean(game?.game_over?.() || visibleBotResult());
    if (!finished) {
      clearTimeout(nextBotTimer);
      nextBotTimer = 0;
      nextBotAttempted = false;
      return;
    }
    if (nextBotAttempted || nextBotTimer) return;
    const button = nextBotGameButton();
    if (!button) return;
    nextBotTimer = setTimeout(() => {
      nextBotTimer = 0;
      if (engineMode !== 'maia' || !autoPlay || !autoNextBot || !botGamePage() || !button.isConnected ||
          !(game?.game_over?.() || visibleBotResult()) || nextBotGameButton() !== button) return;
      nextBotAttempted = true;
      setStatus('Starting next bot game…');
      button.click();
    }, 800);
  }

  // Square coordinates use file X and rank Y, independent of rotation.
  function piecesFrom(boardElement) {
    const pieces = new Map();
    for (const el of boardElement.querySelectorAll('.piece')) {
      const classes = Array.from(el.classList);
      const piece = classes.find(c => /^[wb][prnbqk]$/.test(c));
      const classSquare = classes.map(c => /^square-([1-8])([1-8])$/.exec(c)).find(Boolean);
      const dataSquare = el.getAttribute('data-square');
      const square = /^[1-8]{2}$/.test(dataSquare || '') ? dataSquare :
        classSquare ? `${classSquare[1]}${classSquare[2]}` : null;
      if (!piece || !square) continue;
      if (pieces.has(square)) continue; // Ignore animation duplicates at the same square.
      if ((piece === 'wk' || piece === 'bk') && [...pieces.values()].includes(piece)) continue;
      if (pieces.size >= 32) continue; // A moving piece may briefly exist at two squares.
      pieces.set(square, piece);
    }
    if (!pieces.size) return null;
    if ([...pieces.values()].filter(p => p === 'wk').length !== 1 ||
        [...pieces.values()].filter(p => p === 'bk').length !== 1) return null;
    let placement = '';
    for (let rank = 8; rank >= 1; rank--) {
      let empty = 0;
      for (let file = 1; file <= 8; file++) {
        const p = pieces.get(`${file}${rank}`);
        if (!p) { empty++; continue; }
        if (empty) { placement += empty; empty = 0; }
        placement += p[0] === 'w' ? p[1].toUpperCase() : p[1];
      }
      if (empty) placement += empty;
      if (rank > 1) placement += '/';
    }
    return placement;
  }
  function findBoard() {
    let best = null, bestScore = 0;
    for (const el of document.querySelectorAll('wc-chess-board, chess-board, #board-single, #board-analysis, #game-board, #board, .board, .chess-board, .board-layout-chessboard, [data-cy="board"], [data-test-element="board"], [class*="chessboard"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 160 || r.height < 160 || r.width / r.height < 0.85 || r.width / r.height > 1.15) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const area = r.width * r.height;
      const tag = el.tagName.toLowerCase();
      const score = area * (tag === 'wc-chess-board' || tag === 'chess-board' ? 1.2 : 1) * (el.querySelector('.piece') ? 1.2 : 1);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (!best) {
      const piece = document.querySelector('.piece');
      for (let el = piece?.parentElement; el && el !== document.body; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= 160 && r.height >= 160 && r.width / r.height >= 0.85 && r.width / r.height <= 1.15 &&
            r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth &&
            el.querySelectorAll('.piece').length >= 2) { best = el; break; }
      }
    }
    return best;
  }
  function tryLoadFen(fen, placement) {
    if (typeof fen !== 'string' || !/^[prnbqkPRNBQK1-8/]+ [wb] /.test(fen.trim())) return null;
    const candidate = new ChessClass();
    try {
      if (!candidate.load(fen.trim())) return null;
      return !placement || candidate.fen().split(' ')[0] === placement ? candidate : null;
    } catch { return null; }
  }
  function boardFen(boardElement) {
    for (const el of [boardElement, boardElement.querySelector('wc-chess-board, chess-board')].filter(Boolean)) {
      let fen;
      try {
        if (typeof el.game?.getFEN === 'function') fen = el.game.getFEN();
        else if (typeof el.game?.fen === 'function') fen = el.game.fen();
        else if (typeof el.game?.fen === 'string') fen = el.game.fen;
      }
      catch { /* Some board versions do not expose a game object. */ }
      fen ||= el.getAttribute('data-fen');
      const loaded = tryLoadFen(fen);
      if (loaded) return loaded;
    }
    return null;
  }
  function siteFen(placement) {
    const selectors = ['[data-fen]', 'input[aria-label*="FEN"]', 'input[placeholder*="FEN"]'];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const fen = el.getAttribute('data-fen') || el.value;
        const loaded = tryLoadFen(fen, placement);
        if (loaded) return loaded;
      }
    }
    return null;
  }
  function nextGame(target) {
    if (!game) return null;
    const matches = [];
    for (const move of game.moves({verbose: true})) {
      const candidate = new ChessClass(game.fen());
      try {
        candidate.move({from: move.from, to: move.to, promotion: move.promotion || 'q'});
        if (candidate.fen().split(' ')[0] === target) matches.push(candidate);
      } catch { /* Ignore a transient or unsupported move. */ }
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function transitionMove(before, after) {
    if (!before || !after) return null;
    const target = after.fen().split(' ').slice(0, 2).join(' ');
    const matches = [];
    for (const move of before.moves({verbose: true})) {
      const candidate = new ChessClass(before.fen());
      try {
        candidate.move({from: move.from, to: move.to, promotion: move.promotion || 'q'});
        if (candidate.fen().split(' ').slice(0, 2).join(' ') === target)
          matches.push(`${move.from}${move.to}${move.promotion || ''}`);
      } catch { /* Ignore transient positions. */ }
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function rememberPosition(position) {
    const placement = position.fen().split(' ')[0];
    const positions = seenPositions.get(placement) || new Set();
    positions.add(position.fen());
    seenPositions.set(placement, positions);
  }
  function seenGame(placement) {
    const positions = seenPositions.get(placement);
    return positions?.size === 1 ? tryLoadFen([...positions][0], placement) : null;
  }
  function readOpeningName() {
    const selectors = ['.opening-name', '.eco-name', '.opening-info-name',
      '[data-cy="opening-name"]', '[data-testid="opening-name"]'];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.closest('#maia-web-panel')) continue;
        const name = el.textContent?.trim().replace(/\s+/g, ' ');
        if (name && name.length <= 100) return name;
      }
    }
    return '';
  }

  function scan() {
    const study = studyReviewPage();
    if (study !== lastStudyRoute) { lastStudyRoute = study; syncEngineUi(); }
    const currentOpening = readOpeningName();
    if (currentOpening !== openingName) {
      openingName = currentOpening;
      openingEl.textContent = `Opening: ${openingName || '—'}`;
      publishStreamState();
    }
    const found = findBoard();
    if (found !== board) {
      board = found;
      if (board && shownMoves.length) drawArrows();
      else arrow.style.display = 'none';
    }
    if (!board) { boardReview.hidden = true; if (!engineStarting) setStatus('Scanning Chess.com for a board…'); return; }
    lastBoardOrientation = isBlackView();
    const directFen = boardFen(board);
    const placement = directFen?.fen().split(' ')[0] || piecesFrom(board);
    if (!placement) { boardReview.hidden = true; if (!engineStarting) setStatus('Board found. Waiting for position data…'); return; }
    const fromSite = (directFen?.fen().split(' ')[0] === placement ? directFen : null) || siteFen(placement);
    if (placement !== lastBoard || !game || (fromSite && fromSite.fen() !== game.fen())) {
      const previous = game;
      let next = fromSite;
      if (!next && game && game.fen().split(' ')[0] === placement) next = game;
      if (!next) next = nextGame(placement);
      if (!next) next = seenGame(placement);
      if (!next) {
        const start = new ChessClass();
        if (start.fen().split(' ')[0] === placement) next = start;
      }
      if (!next) {
        missedCount = missedBoard === placement ? missedCount + 1 : 1;
        missedBoard = placement;
        if (missedCount < 3) { setStatus('Board is changing…'); setTimeout(scan, 350); return; }
        game = null; lastBoard = placement; clearPrediction();
        fenEl.textContent = '';
        setStatus('Full FEN unknown. Paste one below, or start a new game from move 1.');
        return;
      }
      missedCount = 0;
      if (botGamePage() && engineMode === 'stockfish' && previous && next &&
          previous.fen() !== next.fen()) {
        if (next.fen().split(' ')[0] === START_PLACEMENT) {
          liveReview = [];
          livePending = null;
          lastSearchResult = null;
          showResearchResult = false;
          reviewSignature = '';
        } else {
          const played = transitionMove(previous, next);
          livePending = played && lastSearchResult?.fen === previous.fen() &&
            Number.isFinite(lastSearchResult.cp) ? {
              fen: previous.fen(), postFen: next.fen(), side: previous.turn(), played,
              best: lastSearchResult.best, bestCp: lastSearchResult.cp,
              depth: lastSearchResult.depth
            } : null;
        }
      }
      game = next; lastBoard = placement; clearPrediction();
      rememberPosition(game);
    }
    maybeStartNextBotGame();
    if (!game) return;
    const fen = game.fen();
    if (fenEl.textContent !== fen) fenEl.textContent = fen;
    if (engineMode === 'maia') {
      if (maiaSession) void predictMaia(fen);
      else if (maiaError) setStatus(maiaError);
    } else if (engineReady && !researchJob) requestAnalysis(fen);
    else if (engineError) setStatus(engineError);
    renderReview();
    keepArrowAligned();
    publishStreamState();
  }
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 60);
  }

  function boardTokens(fen) {
    const tokens = new Float32Array(64 * 96);
    const [placement, side] = fen.split(' ');
    const channels = {p: 0, n: 1, b: 2, r: 3, q: 4, k: 5};
    placement.split('/').forEach((rankText, row) => {
      let file = 0;
      for (const piece of rankText) {
        if (/^[1-8]$/.test(piece)) { file += Number(piece); continue; }
        const square = (7 - row) * 8 + file++;
        const mappedSquare = side === 'b' ? square ^ 56 : square;
        const isBlack = piece === piece.toLowerCase();
        const mappedBlack = side === 'b' ? !isBlack : isBlack;
        const channel = channels[piece.toLowerCase()] + (mappedBlack ? 6 : 0);
        for (let history = 0; history < 8; history++)
          tokens[mappedSquare * 96 + history * 12 + channel] = 1;
      }
    });
    return tokens;
  }
  function moveIndex(move, blackToMove) {
    const mirror = square => blackToMove ? `${square[0]}${9 - Number(square[1])}` : square;
    const from = mirror(move.from), to = mirror(move.to);
    const ff = from.charCodeAt(0) - 97, fr = Number(from[1]) - 1;
    const tf = to.charCodeAt(0) - 97, tr = Number(to[1]) - 1;
    if (move.promotion) {
      const promotion = 'qrbn'.indexOf(move.promotion);
      return promotion < 0 || fr !== 6 || tr !== 7 ? -1 : 4096 + ff * 32 + tf * 4 + promotion;
    }
    return (fr * 8 + ff) * 64 + (tr * 8 + tf);
  }
  function maiaRatingTensor(name) {
    const index = maiaSession.inputNames.indexOf(name);
    const type = maiaSession.inputMetadata?.[index]?.type || 'tensor(int32)';
    if (type === 'int64' || type === 'tensor(int64)')
      return new ortApi.Tensor('int64', BigInt64Array.of(BigInt(maiaRating)), [1]);
    if (type === 'int32' || type === 'tensor(int32)')
      return new ortApi.Tensor('int32', Int32Array.of(maiaRating), [1]);
    throw new Error(`${name} has unsupported type ${type}`);
  }
  function showMaiaValue(logits, blackToMove) {
    if (!logits || logits.length !== 3 || !Array.from(logits).every(Number.isFinite)) {
      shownValue = null;
      valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} —`; });
      valueSegments.forEach(segment => { segment.style.width = '0%'; });
      panel.querySelector('#maia-web-value-bar').setAttribute('aria-label', 'Win probabilities unavailable');
      return;
    }
    const largest = Math.max(...logits);
    const weights = Array.from(logits, value => Math.exp(value - largest));
    const total = weights.reduce((sum, value) => sum + value, 0);
    const [loss, draw, win] = weights.map(value => 100 * value / total);
    shownValue = blackToMove ? [loss, draw, win] : [win, draw, loss];
    valueLabels.forEach((label, index) => {
      label.textContent = `${['White win', 'Draw', 'Black win'][index]} ${shownValue[index].toFixed(1)}%`;
    });
    valueSegments.forEach((segment, index) => { segment.style.width = `${shownValue[index]}%`; });
    panel.querySelector('#maia-web-value-bar').setAttribute('aria-label',
      `Model estimate: white win ${shownValue[0].toFixed(1)}%, draw ${shownValue[1].toFixed(1)}%, black win ${shownValue[2].toFixed(1)}%`);
  }
  async function legacyMaiaModel() {
    try {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('maia-onnx-cache', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('models');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('models', 'readonly').objectStore('models').get(MAIA_MODEL_URL);
          request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    } catch { return null; }
  }
  async function loadMaia() {
    if (engineMode !== 'maia') return;
    if (maiaSession) { scan(); return; }
    if (maiaLoading) {
      await maiaLoading;
      if (engineMode === 'maia' && !maiaSession && !maiaError) return loadMaia();
      return;
    }
    if (!ortApi) { maiaError = 'ONNX Runtime did not load. Check the userscript CDN.'; setStatus(maiaError); return; }
    const generation = maiaGeneration;
    maiaError = '';
    maiaLoading = (async () => {
      ortApi.env.wasm.wasmPaths = ORT_DIST;
      ortApi.env.wasm.numThreads = 1;
      setStatus('Checking saved Maia 79M model…');
      let blob = await cachedAsset(MAIA_MODEL_URL) || await legacyMaiaModel();
      if (generation !== maiaGeneration || engineMode !== 'maia') return;
      if (blob && blob.size < MAIA_MODEL_MIN_BYTES) blob = null;
      if (!blob) {
        setStatus('Downloading Maia 79M model…');
        const controller = new AbortController();
        maiaDownloadController = controller;
        try {
          blob = await downloadAsset(MAIA_MODEL_URL, (loaded, total) => {
            if (generation !== maiaGeneration) return;
            const size = total > 0 && loaded <= total ? total : 313_000_000;
            setStatus(`Downloading Maia 79M: ${Math.min(100, Math.floor(100 * loaded / size))}% (${(loaded / 1e6).toFixed(0)} MB)`);
          }, controller.signal);
        } finally {
          if (maiaDownloadController === controller) maiaDownloadController = null;
        }
        if (blob.size < MAIA_MODEL_MIN_BYTES) throw new Error('Maia model download was incomplete.');
        if (generation === maiaGeneration) {
          setStatus('Saving Maia 79M model…');
          await saveEngineAsset(MAIA_MODEL_URL, blob);
        }
      }
      if (generation !== maiaGeneration || engineMode !== 'maia') return;
      const bytes = await blob.arrayBuffer();
      if (generation !== maiaGeneration || engineMode !== 'maia') return;
      let loaded = null, backend = 'CPU';
      if (navigator.gpu) {
        try {
          setStatus('Initializing Maia 79M on WebGPU…');
          loaded = await ortApi.InferenceSession.create(bytes, {executionProviders: ['webgpu', 'wasm']});
          backend = 'WebGPU';
        } catch (error) { console.warn('[Maia] WebGPU unavailable; using CPU:', error); }
      }
      if (!loaded) {
        setStatus('Initializing Maia 79M on CPU…');
        loaded = await ortApi.InferenceSession.create(bytes, {executionProviders: ['wasm']});
      }
      if (generation !== maiaGeneration || engineMode !== 'maia') { await loaded.release?.(); return; }
      if (!['tokens', 'self_elo', 'oppo_elo'].every(name => loaded.inputNames.includes(name)) ||
          !loaded.outputNames.some(name => name === 'logits_move' || name === 'move_logits')) {
        await loaded.release?.();
        throw new Error('Maia model input/output names do not match its published contract.');
      }
      maiaSession = loaded;
      maiaBackend = backend;
      setStatus(`Maia 79M ready on ${backend}. Scanning board…`);
      lastFen = '';
      scan();
    })().catch(error => {
      if (generation !== maiaGeneration || engineMode !== 'maia') return;
      maiaError = `Maia 79M failed: ${error.message}`;
      setStatus(maiaError);
    }).finally(() => { maiaLoading = null; });
    return maiaLoading;
  }
  async function predictMaia(fen) {
    if (engineMode !== 'maia' || !maiaSession || maiaRun || !game || fen === lastFen) return;
    lastFen = fen;
    const id = ++inferenceId;
    const legal = game.moves({verbose: true});
    if (!legal.length) { setStatus('No legal moves in this position.'); return; }
    let run;
    try {
      const feeds = {
        tokens: new ortApi.Tensor('float32', boardTokens(fen), [1, 64, 96]),
        self_elo: maiaRatingTensor('self_elo'),
        oppo_elo: maiaRatingTensor('oppo_elo')
      };
      setStatus('Maia 79M is predicting…');
      run = maiaSession.run(feeds);
      maiaRun = run;
      const output = await run;
      if (id !== inferenceId || engineMode !== 'maia' || game?.fen() !== fen) return;
      const logits = (output.logits_move || output.move_logits)?.data;
      if (!logits || logits.length < 4352) throw new Error('Expected 4352 Maia move logits.');
      const black = game.turn() === 'b';
      const candidates = legal.map(move => {
        const index = moveIndex(move, black);
        return {uci: `${move.from}${move.to}${move.promotion || ''}`,
          logit: index < 0 ? NaN : Number(logits[index])};
      }).filter(move => Number.isFinite(move.logit));
      if (!candidates.length) throw new Error('No legal move maps to the Maia output.');
      candidates.sort((a, b) => b.logit - a.logit);
      const largest = candidates[0].logit;
      const total = candidates.reduce((sum, move) => sum + Math.exp(move.logit - largest), 0);
      const best = candidates[0];
      const percent = 100 / total;
      shownMoves = [{uci: best.uci, label: `${percent.toFixed(1)}%`, metric: 'Move probability'}];
      movesEl.replaceChildren();
      const item = document.createElement('li');
      item.textContent = `${best.uci} · Move probability ${percent.toFixed(1)}%`;
      movesEl.appendChild(item);
      showMaiaValue(output.logits_value?.data, black);
      drawArrows();
      setStatus(`Maia 79M · ${maiaBackend} · rating ${maiaRating} · ${black ? 'Black' : 'White'} to move`);
      publishStreamState();
      maybeAutoPlay(fen, best.uci);
    } catch (error) {
      if (id === inferenceId && engineMode === 'maia') {
        clearPrediction();
        lastFen = fen;
        setStatus(`Maia inference failed: ${error.message}`);
      }
    } finally {
      if (maiaRun === run) maiaRun = null;
      if (engineMode === 'maia') scan();
    }
  }

  function scaledValue(pawns) {
    return Math.sign(pawns) * Math.log1p(Math.abs(pawns));
  }
  function moveLaw(values, s, c) {
    if (!values.length || !values.every(Number.isFinite) ||
        values.some((value, index) => index && value > values[index - 1]) ||
        !(s > 0) || !(c > 0)) throw new Error('Sorted pawn values and positive fitted s,c are required.');
    const losses = values.map(value => Math.max(0, scaledValue(values[0]) - scaledValue(value)));
    const weights = losses.map(loss => Math.exp(Math.min(27, Math.pow(loss / s, c))));
    let p = 1 / values.length;
    let converged = values.length === 1;
    if (!converged) {
      for (let iteration = 0; iteration < 100; iteration++) {
        const logP = Math.log(p);
        let g = 0, derivative = 0;
        for (const weight of weights) {
          g += Math.exp(weight * logP);
          derivative += weight * Math.exp((weight - 1) * logP);
        }
        if (Math.abs(g - 1) < 1e-14) { converged = true; break; }
        const next = p - (g - 1) / derivative;
        if (!(next > 0 && next < 1)) break;
        p = next;
      }
    }
    let u = -Math.log(p);
    if (!converged) {
      // Safeguard Newton in log space when the root rounds to p = 1 in double precision.
      let low = 0, high = Math.log(values.length);
      for (let iteration = 0; iteration < 200; iteration++) {
        let g = 0, slope = 0;
        for (const weight of weights) {
          const term = Math.exp(-weight * u);
          g += term;
          slope += weight * term;
        }
        if (Math.abs(g - 1) < 1e-14) break;
        if (g > 1) low = u; else high = u;
        const next = u + (g - 1) / slope;
        u = next > low && next < high ? next : (low + high) / 2;
      }
    }
    const probabilities = weights.map(weight => Math.exp(-weight * u));
    const residual = Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1);
    if (residual >= 1e-14) throw new Error(`Move-law normalisation residual ${residual} exceeds tolerance.`);
    return {losses, weights, probabilities, residual};
  }
  function qualityFromLoss(lossCp, bestCp, playedCp, isBest, secondCp = null) {
    let category;
    if (isBest && Number.isFinite(secondCp) && bestCp >= 0 && secondCp <= -100 &&
        bestCp - secondCp >= 150) category = 'Great';
    else if (lossCp <= 10) category = 'Best';
    else if (lossCp <= 35) category = 'Excellent';
    else if (lossCp <= 80) category = 'Good';
    else if (lossCp > 300) category = 'Blunder';
    else if (bestCp >= 150 && playedCp <= 0 && lossCp >= 160) category = 'Miss';
    else if (lossCp <= 160) category = 'Inaccuracy';
    else category = 'Mistake';
    return {category, lossCp, accuracy: 100 * Math.exp(-lossCp / 150)};
  }
  function classifyReviewedMove(result) {
    if (!result.complete || !result.moves?.length) return null;
    const best = result.moves[0];
    const played = result.moves.find(move => move.uci === result.played);
    if (!played || !Number.isFinite(best.cp) || !Number.isFinite(played.cp)) return null;
    const lossCp = Math.max(0, best.cp - played.cp);
    return qualityFromLoss(lossCp, best.cp, played.cp, played.uci === best.uci, result.moves[1]?.cp);
  }
  function studyReviewPage() {
    return /^\/(?:analysis(?:\/|$)|play\/computer(?:\/|$))/.test(location.pathname);
  }
  function reviewForBoard() {
    const entries = reviewEntries();
    return game ? entries.find(item => item.fen === game.fen() && item.review) : null;
  }
  function reviewMoveForBoard() {
    if (!/^\/analysis(?:\/|$)/.test(location.pathname)) return null;
    const item = reviewForBoard();
    if (!item) return null;
    const visual = REVIEW_PALETTE[item.review.category];
    return {uci: item.played, label: `${item.review.accuracy.toFixed(0)}%`,
      metric: `${item.review.category} · review accuracy`, color: visual.color, icon: visual.icon};
  }
  function reviewSummary(entries) {
    const summary = {w: {count: 0, sum: 0, lossCp: 0}, b: {count: 0, sum: 0, lossCp: 0}};
    for (const item of entries) {
      if (!item.review || !summary[item.side]) continue;
      summary[item.side].count++;
      summary[item.side].sum += item.review.accuracy;
      summary[item.side].lossCp += item.review.lossCp;
    }
    return summary;
  }
  function reviewEntries() {
    if (researchJob) return researchJob.results;
    if (botGamePage() && !showResearchResult) return liveReview;
    return researchResult?.positions || liveReview;
  }
  function alignBoardReview() {
    if (boardReview.hidden || !board || streamerMode) return;
    const rect = board.getBoundingClientRect();
    boardReview.style.left = `${Math.max(4, rect.left)}px`;
    boardReview.style.top = `${Math.max(4, rect.top - 36)}px`;
    boardReview.style.maxWidth = `${Math.max(180, rect.width)}px`;
  }
  function renderReview() {
    const entries = reviewEntries();
    const available = entries.some(item => item.review);
    reviewCard.hidden = !available || !studyReviewPage();
    boardReview.hidden = !available || !studyReviewPage() || streamerMode || !board;
    if (!available) { reviewSignature = ''; return; }
    const matched = reviewForBoard();
    const current = matched || (botGamePage() ? liveReview[liveReview.length - 1] : null);
    const signature = `${entries.length}|${game?.fen() || ''}|${streamerMode}|${board?.isConnected}|${location.pathname}|${engineMode}`;
    if (signature === reviewSignature) { alignBoardReview(); return; }
    reviewSignature = signature;
    const totals = reviewSummary(entries);
    const score = side => totals[side].count ? `${(totals[side].sum / totals[side].count).toFixed(1)}%` : '—';
    reviewScores.textContent = `White ${score('w')} (${totals.w.count}) · Black ${score('b')} (${totals.b.count})`;
    const completed = totals.w.count + totals.b.count;
    const meanLoss = completed ? (totals.w.lossCp + totals.b.lossCp) / completed : 0;
    reviewDetails.textContent = `${completed}/${entries.length} moves scored · mean loss ${meanLoss.toFixed(0)} cp`;
    reviewCurrent.textContent = current
      ? `${matched ? 'Reviewed move' : 'Last evaluated move'} · ${current.review.category} ${REVIEW_PALETTE[current.review.category].icon} · ${current.played} · ${current.review.lossCp} cp lost${current.review.depth ? ` · depth ${current.review.depth}` : ''}`
      : 'Open a reviewed position to see its move label.';
    reviewCurrent.style.color = current ? REVIEW_PALETTE[current.review.category].color : '';
    const counts = Object.fromEntries(Object.keys(REVIEW_PALETTE).map(name => [name, 0]));
    for (const item of entries) if (item.review) counts[item.review.category]++;
    reviewLegend.replaceChildren();
    for (const [name, visual] of Object.entries(REVIEW_PALETTE)) {
      const chip = document.createElement('span');
      chip.className = 'review-chip';
      chip.style.background = visual.color;
      chip.textContent = `${visual.icon} ${name} ${counts[name]}`;
      chip.title = REVIEW_RULES[name];
      chip.setAttribute('aria-label', `${name}: ${counts[name]}. ${REVIEW_RULES[name]}`);
      chip.setAttribute('aria-disabled', counts[name] ? 'false' : 'true');
      reviewLegend.appendChild(chip);
    }
    boardReview.textContent = `Review accuracy · White ${score('w')} · Black ${score('b')}` +
      (current ? ` · ${current.review.category} ${REVIEW_PALETTE[current.review.category].icon}` : '') +
      (botGamePage() && engineMode === 'maia' ? ' · evaluation paused' : '');
    boardReview.style.borderColor = current ? REVIEW_PALETTE[current.review.category].color : '#59708a';
    alignBoardReview();
    if (reviewMoveForBoard()) drawArrows();
  }
  function startPostgameResearch() {
    if (researchJob) return;
    if (engineMode !== 'stockfish') { researchNoteEl.textContent = 'Select Precision style to run the fixed-depth move review.'; return; }
    if (!engineReady || !worker) { researchNoteEl.textContent = 'Precision search must finish loading first.'; return; }
    const pgn = panel.querySelector('#maia-web-pgn').value.trim();
    const side = panel.querySelector('#maia-web-research-side').value;
    const sText = panel.querySelector('#maia-web-s').value.trim();
    const cText = panel.querySelector('#maia-web-c').value.trim();
    if (Boolean(sText) !== Boolean(cText)) {
      researchNoteEl.textContent = 'Enter both fitted s and c, or leave both blank for scaled-loss export.';
      return;
    }
    const s = sText ? Number(sText) : null, c = cText ? Number(cText) : null;
    if (sText && (!(s > 0) || !(c > 0))) {
      researchNoteEl.textContent = 'Fitted s and c must both be positive.';
      return;
    }
    const parsed = new ChessClass();
    try {
      if (!parsed.load_pgn(pgn)) throw new Error('PGN could not be parsed.');
      const history = parsed.history({verbose: true});
      while (parsed.undo()) { /* Return to the PGN's starting FEN, if one was supplied. */ }
      const replay = new ChessClass(parsed.fen());
      const positions = [];
      for (const move of history) {
        if (side === 'both' || replay.turn() === side) positions.push({
          fen: replay.fen(), side: replay.turn(), played: `${move.from}${move.to}${move.promotion || ''}`,
          legal: replay.moves({verbose: true}).map(candidate =>
            `${candidate.from}${candidate.to}${candidate.promotion || ''}`)
        });
        replay.move({from: move.from, to: move.to, promotion: move.promotion || 'q'});
      }
      if (!positions.length) throw new Error('PGN has no moves for the selected side.');
      researchResult = null;
      showResearchResult = true;
      researchJob = {positions, results: [], index: 0, active: null, side, s, c, cancelled: false};
      renderReview();
      panel.querySelector('#maia-web-research-run').disabled = true;
      panel.querySelector('#maia-web-research-cancel').disabled = false;
      panel.querySelector('#maia-web-research-download').disabled = true;
      pendingSearch = null;
      lastFen = '';
      if (activeSearch) { activeSearch.stale = true; worker.postMessage('stop'); }
      else beginPostgamePosition();
    } catch (error) { researchNoteEl.textContent = `Research setup failed: ${error.message}`; }
  }
  function beginPostgamePosition() {
    if (!researchJob || researchJob.active || activeSearch || !worker) return;
    if (researchJob.cancelled || researchJob.index >= researchJob.positions.length) {
      finishPostgameResearch();
      return;
    }
    const position = researchJob.positions[researchJob.index];
    researchJob.active = {position, scores: new Map()};
    researchNoteEl.textContent = `Fixed depth ${RESEARCH_DEPTH}: position ${researchJob.index + 1}/${researchJob.positions.length}, ${position.legal.length} legal moves…`;
    worker.postMessage(`setoption name MultiPV value ${position.legal.length}`);
    worker.postMessage(`position fen ${position.fen}`);
    worker.postMessage(`go depth ${RESEARCH_DEPTH}`);
  }
  function postgameEngineLine(line) {
    const active = researchJob?.active;
    if (!active) return false;
    if (line.startsWith('info ')) {
      if (researchJob.cancelled || /\b(?:upperbound|lowerbound)\b/.test(line)) return true;
      const foundDepth = /\bdepth (\d+)/.exec(line);
      const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
      const pv = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line);
      if (foundDepth && score && pv && active.position.legal.includes(pv[1])) {
        const previous = active.scores.get(pv[1]);
        const found = {uci: pv[1], depth: Number(foundDepth[1]),
          cp: score[1] === 'cp' ? Number(score[2]) : null,
          mate: score[1] === 'mate' ? Number(score[2]) : null};
        if (!previous || found.depth >= previous.depth) active.scores.set(pv[1], found);
      }
      return true;
    }
    if (!line.startsWith('bestmove ')) return false;
    if (!researchJob.cancelled) {
      const moves = active.position.legal.map(uci => active.scores.get(uci) || {uci, depth: 0, cp: null, mate: null});
      const complete = moves.every(move => move.depth >= RESEARCH_DEPTH);
      const centipawnsOnly = moves.every(move => Number.isFinite(move.cp));
      const sorted = centipawnsOnly ? [...moves].sort((a, b) => b.cp - a.cp) : moves;
      const result = {fen: active.position.fen, side: active.position.side, played: active.position.played,
        legalCount: active.position.legal.length, complete, moves: sorted,
        reason: !complete ? 'Missing full-depth evaluation for one or more moves' :
          !centipawnsOnly ? 'Mate scores cannot be converted to pawn values without a stated rule' : null};
      if (complete && centipawnsOnly) {
        const pawnValues = sorted.map(move => move.cp / 100);
        result.scaledLosses = pawnValues.map(value => scaledValue(pawnValues[0]) - scaledValue(value));
        result.moves.forEach((move, index) => { move.delta = result.scaledLosses[index]; });
        if (researchJob.s !== null) {
          try {
            const law = moveLaw(pawnValues, researchJob.s, researchJob.c);
            result.moves.forEach((move, index) => {
              move.weight = law.weights[index];
              move.probability = law.probabilities[index];
            });
            result.normalizationResidual = law.residual;
          } catch (error) { result.reason = `Move law unavailable: ${error.message}`; }
        }
      }
      result.review = classifyReviewedMove(result);
      researchJob.results.push(result);
      renderReview();
      researchJob.index++;
    }
    researchJob.active = null;
    beginPostgamePosition();
    return true;
  }
  function finishPostgameResearch() {
    if (!researchJob) return;
    const job = researchJob;
    researchJob = null;
    if (worker && engineReady) worker.postMessage('setoption name MultiPV value 1');
    panel.querySelector('#maia-web-research-run').disabled = false;
    panel.querySelector('#maia-web-research-cancel').disabled = true;
    if (job.cancelled) researchNoteEl.textContent = 'Post-game research cancelled.';
    else {
      researchResult = {
        engine: 'stockfish@19.0.1 full single-threaded WASM', depth: RESEARCH_DEPTH,
        multipv: 'all legal moves per position', side: job.side,
        calibration: job.s === null ? null : {s: job.s, c: job.c, source: 'user supplied; not verified'},
        eProcess: null,
        eProcessReason: 'Requires fitted joint alternative q, two-regime clock density, rating corridor and held-out calibration.',
        positions: job.results,
        review: {formula: 'Mean of 100 * exp(-centipawn loss / 150) over fully evaluated moves',
          thresholdsCp: {Best: 10, Excellent: 35, Good: 80, Inaccuracy: 160, Mistake: 300},
          summary: reviewSummary(job.results),
          unsupported: ['Brilliant: requires validated sacrifice analysis', 'Book: requires an opening book']}
      };
      panel.querySelector('#maia-web-research-download').disabled = false;
      researchNoteEl.textContent = `Reviewed ${job.results.length} positions at fixed depth ${RESEARCH_DEPTH}. Scores are this project's evaluation-loss metric, not Chess.com accuracy. Brilliant and Book require additional evidence. E_N remains unavailable without calibration.`;
    }
    renderReview();
    lastFen = '';
    scan();
  }

  function beginSearch() {
    if (engineMode !== 'stockfish' || !engineReady || activeSearch || !pendingSearch || !worker || researchJob) return;
    activeSearch = {...pendingSearch, stale: false, evaluation: null, reachedDepth: 0};
    pendingSearch = null;
    worker.postMessage(`position fen ${activeSearch.fen}`);
    worker.postMessage(`go depth ${activeSearch.depth}`);
    setStatus(`Stockfish 19 · analyzing depth ${activeSearch.depth}…`);
  }
  function requestAnalysis(fen) {
    if (engineMode !== 'stockfish' || !engineReady || !game || researchJob || fen === lastFen) return;
    if (!game.moves().length) {
      lastFen = fen;
      setStatus('No legal moves in this position.');
      return;
    }
    lastFen = fen;
    pendingSearch = {fen, depth};
    if (activeSearch) {
      if (!activeSearch.stale) {
        activeSearch.stale = true;
        worker.postMessage('stop');
      }
    } else beginSearch();
  }
  function engineLine(line) {
    if (engineMode !== 'stockfish') return;
    if (line === 'uciok') {
      worker.postMessage('setoption name Hash value 32');
      worker.postMessage('setoption name MultiPV value 1');
      worker.postMessage('setoption name UCI_LimitStrength value false');
      worker.postMessage('setoption name Skill Level value 20');
      worker.postMessage('setoption name UCI_ShowWDL value true');
      worker.postMessage('isready');
      return;
    }
    if (line === 'readyok') {
      engineStarting = false;
      engineReady = true;
      engineError = '';
      if (wasmBlobUrl) { URL.revokeObjectURL(wasmBlobUrl); wasmBlobUrl = ''; }
      setStatus(`Stockfish 19 ready${engineCached ? ' (saved engine)' : ''}. Scanning board…`);
      scan();
      return;
    }
    if (postgameEngineLine(line)) return;
    if (line.startsWith('info ') && activeSearch && !activeSearch.stale && game?.fen() === activeSearch.fen) {
      const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
      if (!score || /\b(?:upperbound|lowerbound)\b/.test(line)) return;
      const wdl = /\bwdl (\d+) (\d+) (\d+)/.exec(line);
      const foundDepth = /\bdepth (\d+)/.exec(line);
      const reachedDepth = foundDepth ? Number(foundDepth[1]) : 0;
      if (reachedDepth < activeSearch.reachedDepth) return;
      activeSearch.reachedDepth = reachedDepth;
      activeSearch.evaluation = {
        cp: score[1] === 'cp' ? Number(score[2]) : null,
        mate: score[1] === 'mate' ? Number(score[2]) : null,
        wdl: wdl ? wdl.slice(1).map(Number) : null
      };
      showValue(activeSearch.evaluation, game.turn() === 'b');
      setStatus(`Stockfish 19 · depth ${reachedDepth}/${activeSearch.depth} · ${game.turn() === 'b' ? 'Black' : 'White'} to move`);
      publishStreamState();
      return;
    }
    if (!line.startsWith('bestmove ') || !activeSearch) return;
    const finished = activeSearch;
    activeSearch = null;
    if (!finished.stale && !pendingSearch && game?.fen() === finished.fen) {
      const best = /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line)?.[1];
      const legal = game.moves({verbose: true}).some(move =>
        `${move.from}${move.to}${move.promotion || ''}` === best);
      if (best && legal) {
        const expected = stockfishExpectedScore(finished.evaluation);
        shownMoves = [{uci: best, label: expected === null ? '' : `${expected.toFixed(1)}%`,
          metric: 'Expected score',
          ...(studyReviewPage() ? {color: REVIEW_PALETTE.Best.color, icon: REVIEW_PALETTE.Best.icon} : {})}];
        movesEl.replaceChildren();
        const item = document.createElement('li');
        item.textContent = expected === null ? `${best} · WDL unavailable` :
          `${best} · ${studyReviewPage() ? 'Best at search depth · ' : ''}Expected score ${expected.toFixed(1)}%`;
        movesEl.appendChild(item);
        showValue(finished.evaluation, game.turn() === 'b');
        if (botGamePage() && Number.isFinite(finished.evaluation?.cp)) {
          if (livePending?.postFen === finished.fen && livePending.side !== game.turn()) {
            const lossCp = livePending.played === livePending.best ? 0 :
              Math.max(0, livePending.bestCp + finished.evaluation.cp);
            const playedCp = livePending.bestCp - lossCp;
            liveReview.push({fen: livePending.fen, postFen: finished.fen,
              side: livePending.side, played: livePending.played,
              review: {...qualityFromLoss(lossCp, livePending.bestCp, playedCp,
                livePending.played === livePending.best), depth: Math.min(livePending.depth,
                finished.reachedDepth || finished.depth)}});
            livePending = null;
          }
          lastSearchResult = {fen: finished.fen, cp: finished.evaluation.cp, best,
            depth: finished.reachedDepth || finished.depth};
          renderReview();
        }
        drawArrows();
        setStatus(`Stockfish 19 · depth ${finished.reachedDepth || finished.depth} · ${game.turn() === 'b' ? 'Black' : 'White'} to move`);
      } else {
        clearPrediction();
        setStatus(best === undefined ? 'No legal moves.' : 'Stockfish returned an invalid move. Rescanning…');
      }
      publishStreamState();
    }
    if (researchJob) beginPostgamePosition();
    else beginSearch();
  }
  function downloadAsset(url, onProgress, signal) {
    if (signal?.aborted) return Promise.reject(new Error('Download cancelled'));
    if (typeof GM_xmlhttpRequest !== 'function') {
      return fetch(url, {signal}).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${url}`);
        return response.blob();
      });
    }
    return new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => {
        try { request?.abort?.(); } catch { /* The request may already have ended. */ }
        finish(reject, new Error('Download cancelled'));
      };
      signal?.addEventListener('abort', abort, {once: true});
      request = GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob',
        onprogress: event => onProgress?.(event.loaded, event.total),
        onload: response => response.status >= 200 && response.status < 300 && response.response
          ? finish(resolve, response.response)
          : finish(reject, new Error(`HTTP ${response.status} while downloading ${url}`)),
        onerror: () => finish(reject, new Error(`Network error while downloading ${url}`)),
        ontimeout: () => finish(reject, new Error(`Timed out while downloading ${url}`)),
        onabort: () => finish(reject, new Error('Download cancelled'))
      });
      if (signal?.aborted) abort();
    });
  }
  function openEngineCache() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const request = indexedDB.open(ENGINE_CACHE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
  }
  async function cachedAsset(url) {
    try {
      const db = await openEngineCache();
      return await new Promise((resolve, reject) => {
        const request = db.transaction('assets', 'readonly').objectStore('assets').get(url);
        request.onsuccess = () => { db.close(); resolve(request.result instanceof Blob && request.result.size ? request.result : null); };
        request.onerror = () => { db.close(); reject(request.error); };
      });
    } catch {
      cacheAvailable = false;
      return null;
    }
  }
  async function saveEngineAsset(url, blob) {
    if (!cacheAvailable) return;
    try {
      const db = await openEngineCache();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('assets', 'readwrite');
        transaction.objectStore('assets').put(blob, url);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    } catch {
      cacheAvailable = false; // Private mode or storage quota: run the downloaded engine anyway.
    }
  }
  async function loadEngineAsset(url, label, onProgress) {
    const saved = await cachedAsset(url);
    if (saved) return {blob: saved, cached: true};
    if (engineMode === 'stockfish') setStatus(`Downloading Stockfish 19 ${label}…`);
    const blob = await downloadAsset(url, onProgress);
    if (engineMode === 'stockfish') setStatus(`Saving Stockfish 19 ${label} for future visits…`);
    await saveEngineAsset(url, blob);
    return {blob, cached: false};
  }
  function stopStockfishEngine() {
    engineGeneration++;
    worker?.terminate();
    worker = null;
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    if (wasmBlobUrl) URL.revokeObjectURL(wasmBlobUrl);
    workerUrl = wasmBlobUrl = '';
    engineReady = engineStarting = false;
    activeSearch = pendingSearch = null;
  }
  async function startEngine() {
    if (engineMode !== 'stockfish' || engineStarting || engineReady) return;
    const generation = ++engineGeneration;
    if (worker) worker.terminate();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    if (wasmBlobUrl) URL.revokeObjectURL(wasmBlobUrl);
    worker = null;
    workerUrl = wasmBlobUrl = '';
    engineReady = false;
    engineStarting = true;
    engineError = '';
    engineCached = false;
    activeSearch = pendingSearch = null;
    lastFen = '';
    setStatus('Checking saved Stockfish 19 engine…');
    try {
      const scriptAsset = await loadEngineAsset(ENGINE_SCRIPT, 'script');
      if (generation !== engineGeneration || engineMode !== 'stockfish') return;
      const wasmAsset = await loadEngineAsset(ENGINE_WASM, 'WASM', (loaded, total) => {
        if (generation !== engineGeneration || engineMode !== 'stockfish') return;
        const progress = Number.isFinite(total) && total > 0 && loaded <= total
          ? `${Math.min(100, Math.floor(100 * loaded / total))}%`
          : `${(Math.max(0, loaded) / 1e6).toFixed(1)} MB`;
        setStatus(`Downloading Stockfish 19 WASM: ${progress}`);
      });
      if (generation !== engineGeneration || engineMode !== 'stockfish') return;
      engineCached = scriptAsset.cached && wasmAsset.cached;
      setStatus(engineCached ? 'Loading saved Stockfish 19 engine…' : 'Starting Stockfish 19 engine…');
      workerUrl = URL.createObjectURL(new Blob([scriptAsset.blob], {type: 'text/javascript'}));
      wasmBlobUrl = URL.createObjectURL(new Blob([wasmAsset.blob], {type: 'application/wasm'}));
      // The Stockfish worker accepts a WASM URL in its own URL fragment.
      worker = new Worker(`${workerUrl}#${encodeURIComponent(wasmBlobUrl)}`);
      worker.onmessage = event => {
        if (generation !== engineGeneration || engineMode !== 'stockfish') return;
        for (const line of String(event.data).split(/\r?\n/)) {
          if (line === 'info WillOutputEngineDownloadProgress') {
            const channel = new MessageChannel();
            channel.port1.onmessage = progress => {
              if (engineReady) { channel.port1.close(); return; }
              const percent = Math.min(100, Math.round(100 * (progress.data?.percent || 0)));
              setStatus(`Loading Stockfish 19 WASM: ${percent}%`);
              if (percent >= 100) channel.port1.close();
            };
            worker.postMessage({progressPort: channel.port2}, [channel.port2]);
          } else if (line) engineLine(line.trim());
        }
      };
      worker.onerror = event => {
        if (generation !== engineGeneration || engineMode !== 'stockfish') return;
        engineStarting = engineReady = false;
        engineError = `Stockfish 19 failed to load: ${event.message || 'worker error'}`;
        setStatus(engineError);
        worker?.terminate();
        worker = null;
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        if (wasmBlobUrl) URL.revokeObjectURL(wasmBlobUrl);
        workerUrl = wasmBlobUrl = '';
        if (researchJob) {
          researchJob.cancelled = true;
          finishPostgameResearch();
          researchNoteEl.textContent = engineError;
        }
      };
      worker.postMessage('setoption name CanOutputEngineDownloadProgress');
      worker.postMessage('uci');
    } catch (error) {
      if (generation !== engineGeneration || engineMode !== 'stockfish') return;
      engineStarting = engineReady = false;
      engineError = `Stockfish 19 failed to start: ${error.message}`;
      setStatus(engineError);
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      if (wasmBlobUrl) URL.revokeObjectURL(wasmBlobUrl);
      workerUrl = wasmBlobUrl = '';
    }
  }

  function stockfishExpectedScore(evaluation) {
    const wdl = evaluation?.wdl;
    if (Array.isArray(wdl) && wdl.length === 3 && wdl.every(value => Number.isFinite(value) && value >= 0)) {
      const total = wdl.reduce((sum, value) => sum + value, 0);
      if (total > 0) return 100 * (wdl[0] + wdl[1] / 2) / total;
    }
    if (Number.isFinite(evaluation?.mate)) return evaluation.mate > 0 ? 100 : 0;
    return null;
  }
  function showValue(evaluation, blackToMove) {
    if (!evaluation) {
      shownValue = null;
      valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} —`; });
      valueSegments.forEach(segment => { segment.style.width = '0%'; });
      panel.querySelector('#maia-web-value-bar').setAttribute('aria-label', 'Win probabilities unavailable');
      return;
    }
    let win, draw, loss;
    const wdl = evaluation.wdl;
    const total = Array.isArray(wdl) && wdl.length === 3 &&
      wdl.every(value => Number.isFinite(value) && value >= 0) ? wdl.reduce((sum, value) => sum + value, 0) : 0;
    if (total > 0) {
      [win, draw, loss] = wdl.map(value => 100 * value / total);
    } else if (Number.isFinite(evaluation.mate)) {
      [win, draw, loss] = evaluation.mate > 0 ? [100, 0, 0] : [0, 0, 100];
    } else {
      shownValue = null;
      valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} —`; });
      valueSegments.forEach(segment => { segment.style.width = '0%'; });
      panel.querySelector('#maia-web-value-bar').setAttribute('aria-label', 'Win probabilities unavailable');
      return;
    }
    const percentages = blackToMove ? [loss, draw, win] : [win, draw, loss];
    shownValue = percentages;
    valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} ${percentages[index].toFixed(1)}%`; });
    valueSegments.forEach((segment, index) => { segment.style.width = `${percentages[index]}%`; });
    panel.querySelector('#maia-web-value-bar').setAttribute('aria-label', `Estimated: white win ${percentages[0].toFixed(1)}%, draw ${percentages[1].toFixed(1)}%, black win ${percentages[2].toFixed(1)}%`);
  }
  function publishStreamState() {
    if (!streamerMode || !streamChannel) return;
    const reviewed = reviewMoveForBoard();
    const entries = reviewEntries();
    const totals = reviewSummary(entries);
    const recent = botGamePage() ? liveReview[liveReview.length - 1] : null;
    const recentVisual = recent?.review && recent.postFen === game?.fen()
      ? REVIEW_PALETTE[recent.review.category] : null;
    const state = {type: 'state', status: statusEl.textContent, opening: openingName,
      fen: game?.fen() || '', blackView: board ? isBlackView() : lastBoardOrientation,
      skin: captureBoardSkin(),
      engineMode, depth, maiaRating, autoPlay, autoNextBot, study: studyReviewPage(),
      moves: (reviewed ? [reviewed] : shownMoves).map(move =>
        ({uci: move.uci, label: move.label, metric: move.metric, color: move.color, icon: move.icon})),
      recent: recentVisual ? {uci: recent.played, label: `${recent.review.accuracy.toFixed(0)}%`,
        color: recentVisual.color, icon: recentVisual.icon} : null,
      review: studyReviewPage() && entries.some(item => item.review) ? {
        white: totals.w.count ? totals.w.sum / totals.w.count : null,
        black: totals.b.count ? totals.b.sum / totals.b.count : null} : null,
      value: shownValue ? [...shownValue] : null};
    const signature = JSON.stringify(state);
    if (signature === lastStreamSignature) return;
    lastStreamSignature = signature;
    streamChannel.postMessage(state);
  }
  function stopStreamerMode() {
    if (!streamerMode) return;
    streamerMode = false;
    saveSetting('streamer', 'false');
    try { localStorage.setItem('stockfish-streamer-active', 'false'); }
    catch { /* Private browsing may disable storage. */ }
    lastStreamSignature = '';
    try { streamChannel?.close(); popupChannel?.close(); }
    catch { /* The popup may already be closed. */ }
    streamChannel = popupChannel = null;
    if (streamPopup && !streamPopup.closed) streamPopup.close();
    streamPopup = null;
    panel.style.display = '';
    panel.querySelector('#maia-web-streamer').textContent = 'Streamer Mode: OFF';
    renderReview();
    if (!arrow.isConnected) document.documentElement.appendChild(arrow);
    drawArrows();
  }
  function startStreamerMode() {
    if (streamerMode) return;
    if (typeof BroadcastChannel !== 'function') {
      setStatus('This browser does not support BroadcastChannel.');
      return;
    }
    const popup = window.open('', 'stockfish-streamer-popup', 'popup,width=340,height=640');
    if (!popup) { setStatus('Allow popups for Chess.com, then try Streamer Mode again.'); return; }
    try {
      popup.document.open();
      popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Board Studio Streamer View</title>
        <style>body{margin:0;background:#121c28;color:#f6f8fb;font:14px/1.5 system-ui,-apple-system,sans-serif}
        main{padding:16px}h1{margin:0 0 14px;font-size:18px}.row{display:flex;align-items:center;gap:8px;margin:10px 0}
        button{background:#33485d;color:#fff;border:1px solid #708296;border-radius:6px;padding:7px;font:inherit;cursor:pointer}
        #status{color:#c6d5e4;min-height:40px;margin:12px 0}#opening{color:#a9dbc2;margin:6px 0}
        ol{padding-left:24px;font:16px/1.8 ui-monospace,monospace;min-height:88px}
        #labels{display:flex;justify-content:space-between;font-size:11px;gap:4px}
        #bar{display:flex;height:16px;border:1px solid #708296;border-radius:6px;overflow:hidden;background:#33485d}
        #bar span{min-width:0;height:100%}#white{background:#f5f5ed}#draw{background:#cfb951}#black{background:#242b35}
        #mini-board{position:relative;display:grid;grid-template-columns:repeat(8,1fr);width:240px;height:240px;
          margin:10px auto;border:2px solid #708296;box-sizing:content-box}
        #mini-board .square{display:flex;align-items:center;justify-content:center;font:27px/1 'Segoe UI Symbol',serif}
        #mini-board .light{background:#eeeed2}#mini-board .dark{background:#769656}
        #mini-board .white-piece{color:#fff;text-shadow:0 1px 2px #111,1px 0 #111,-1px 0 #111}
        #mini-board .black-piece{color:#182018;text-shadow:0 1px 1px #fff9}
        #mini-arrow{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
        </style></head><body><main><h1>${studyReviewPage() ? 'Board Studio' : engineMode === 'maia' ? 'Maia 79M' : 'Stockfish 19'}</h1><div id="status">Connecting…</div>
        <div id="depth">Depth: 11</div><div id="opening">Opening: —</div><div id="review" hidden></div><div id="mini-board" aria-label="Current chess position"><svg id="mini-arrow" viewBox="0 0 100 100" aria-hidden="true"></svg></div>
        <ol id="moves"></ol><div id="labels"><span>White win —</span><span>Draw —</span><span>Black win —</span></div>
        <div id="bar"><span id="white"></span><span id="draw"></span><span id="black"></span></div>
        <div class="row"><button id="human">${studyReviewPage() ? 'Human style' : 'Enable human moves'}: ${engineMode === 'maia' ? 'ON' : 'OFF'}</button></div>
        <div class="row"><button id="auto" ${engineMode === 'maia' ? '' : 'hidden'}>${studyReviewPage() ? 'Auto-play' : 'Auto-play Maia'}: ${autoPlay ? 'ON' : 'OFF'}</button></div>
        <div class="row"><button id="next" ${engineMode === 'maia' ? '' : 'hidden'}>Auto next bot game: ${autoNextBot ? 'ON' : 'OFF'}</button></div>
        <div class="row"><button id="off">Streamer Mode: ON · Turn off</button></div></main></body></html>`);
      popup.document.close();
      const miniBoard = popup.document.getElementById('mini-board');
      const miniArrow = popup.document.getElementById('mini-arrow');
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
        const cell = popup.document.createElement('div');
        cell.className = `square ${(row + col) % 2 ? 'dark' : 'light'}`;
        cell.appendChild(popup.document.createElement('span'));
        miniBoard.insertBefore(cell, miniArrow);
      }
      const channelName = `stockfish-streamer-${crypto.randomUUID?.() || Date.now()}`;
      streamChannel = new BroadcastChannel(channelName);
      popupChannel = new popup.BroadcastChannel(channelName);
      streamChannel.onmessage = event => {
        if (event.data?.type === 'off') stopStreamerMode();
        if (event.data?.type === 'engine-toggle') humanButton.click();
        if (event.data?.type === 'auto-toggle') autoButton.click();
        if (event.data?.type === 'next-toggle') nextButton.click();
      };
      popupChannel.onmessage = event => {
        if (event.data?.type !== 'state' || popup.closed) return;
        const state = event.data;
        popup.document.querySelector('h1').textContent = state.study ? 'Board Studio' :
          state.engineMode === 'maia' ? 'Maia 79M · Human moves' : 'Stockfish 19';
        popup.document.getElementById('human').textContent = `${state.study ? 'Human style' : 'Enable human moves'}: ${state.engineMode === 'maia' ? 'ON' : 'OFF'}`;
        popup.document.getElementById('auto').hidden = state.engineMode !== 'maia';
        popup.document.getElementById('auto').textContent = `${state.study ? 'Auto-play' : 'Auto-play Maia'}: ${state.autoPlay ? 'ON' : 'OFF'}`;
        popup.document.getElementById('next').hidden = state.engineMode !== 'maia';
        popup.document.getElementById('next').textContent = `Auto next bot game: ${state.autoNextBot ? 'ON' : 'OFF'}`;
        popup.document.getElementById('status').textContent = state.status;
        popup.document.getElementById('depth').textContent = state.engineMode === 'maia'
          ? `${state.study ? 'Human rating' : 'Maia rating'}: ${state.maiaRating} · single pass` : `Depth: ${state.depth}`;
        popup.document.getElementById('opening').textContent = `Opening: ${state.opening || '—'}`;
        const reviewLine = popup.document.getElementById('review');
        reviewLine.hidden = !state.review;
        const formatReview = value => value === null ? '—' : `${value.toFixed(1)}%`;
        reviewLine.textContent = state.review ? `Review accuracy · White ${formatReview(state.review.white)} · Black ${formatReview(state.review.black)}` : '';
        renderMiniBoard(popup.document, state.fen, state.blackView, state.moves[0], state.skin, state.recent);
        const list = popup.document.getElementById('moves');
        list.replaceChildren();
        for (const move of state.moves.slice(0, 1)) {
          const item = popup.document.createElement('li');
          item.textContent = move.label ? `${move.uci} · ${move.metric || 'Score'} ${move.label}` :
            `${move.uci} · WDL unavailable`;
          list.appendChild(item);
        }
        const labels = popup.document.querySelectorAll('#labels span');
        const segments = ['white', 'draw', 'black'].map(id => popup.document.getElementById(id));
        labels.forEach((label, index) => {
          label.textContent = `${['White win', 'Draw', 'Black win'][index]} ${state.value ? `${state.value[index].toFixed(1)}%` : '—'}`;
          segments[index].style.width = state.value ? `${state.value[index]}%` : '0%';
        });
      };
      popup.document.getElementById('human').addEventListener('click', () => popupChannel.postMessage({type: 'engine-toggle'}));
      popup.document.getElementById('auto').addEventListener('click', () => popupChannel.postMessage({type: 'auto-toggle'}));
      popup.document.getElementById('next').addEventListener('click', () => popupChannel.postMessage({type: 'next-toggle'}));
      popup.document.getElementById('off').addEventListener('click', () => popupChannel.postMessage({type: 'off'}));
      streamPopup = popup;
      streamerMode = true;
      boardReview.hidden = true;
      saveSetting('streamer', 'true');
      try { localStorage.setItem('stockfish-streamer-active', 'true'); }
      catch { /* Private browsing may disable storage. */ }
      arrow.replaceChildren();
      arrow.style.display = 'none';
      arrow.remove();
      panel.querySelector('#maia-web-streamer').textContent = 'Streamer Mode: ON';
      panel.style.display = 'none';
      publishStreamState();
      popup.focus();
    } catch (error) {
      if (streamerMode) stopStreamerMode();
      else {
        try { streamChannel?.close(); popupChannel?.close(); popup.close(); }
        catch { /* Keep the main panel usable if popup setup fails. */ }
        streamChannel = popupChannel = null;
      }
      setStatus(`Streamer Mode failed: ${error.message}`);
    }
  }
  function syncEngineUi() {
    const maia = engineMode === 'maia';
    const study = studyReviewPage();
    humanButton.textContent = `${study ? 'Human style' : 'Enable human moves'}: ${maia ? 'ON' : 'OFF'}`;
    humanButton.title = study ? 'Choose human probability model or precision search' : 'Switch between Maia 3 and Stockfish 19';
    autoButton.textContent = `${study ? 'Auto-play' : 'Auto-play Maia'}: ${autoPlay ? 'ON' : 'OFF'}`;
    autoSideEl.setAttribute('aria-label', study ? 'Side for auto-play' : 'Side for Maia auto-play');
    nextButton.textContent = `Auto next bot game: ${autoNextBot ? 'ON' : 'OFF'}`;
    panel.querySelector('#maia-web-auto-row').hidden = !maia;
    panel.querySelector('#maia-web-next-row').hidden = !maia;
    panel.querySelector('#maia-web-head span').textContent = study ? 'Board Studio' :
      maia ? 'Maia 79M · Human moves' : 'Stockfish 19';
    panel.querySelector('#maia-web-stockfish-settings').hidden = maia;
    panel.querySelector('#maia-web-stockfish-strength').hidden = maia;
    panel.querySelector('#maia-web-maia-settings').hidden = !maia;
    panel.querySelector('#maia-web-maia-note').hidden = !maia;
    panel.querySelector('#maia-web-maia-settings label').textContent = study ? 'Human rating' : 'Maia rating';
    panel.querySelector('#maia-web-maia-note').textContent = study ?
      'Probability model · one pass; no search depth' : 'Maia 79M · one prediction pass; no search depth';
    panel.querySelector('#maia-web-stockfish-strength').textContent = study ?
      'Maximum search · Elo varies' : 'Full build · Max skill · Elo varies';
    panel.querySelector('#maia-web-retry').textContent = maia ? (study ? 'Load model' : 'Load Maia') : 'Retry analysis';
    publishStreamState();
  }
  humanButton.addEventListener('click', () => {
    if (researchJob) { setStatus('Finish or cancel post-game research before switching engines.'); return; }
    if (engineMode === 'stockfish') {
      engineMode = 'maia';
      saveSetting('engine', engineMode);
      maiaGeneration++;
      stopStockfishEngine();
      livePending = null;
      lastSearchResult = null;
      autoPlayedFen = '';
      clearPrediction();
      syncEngineUi();
      void loadMaia();
    } else {
      engineMode = 'stockfish';
      saveSetting('engine', engineMode);
      maiaGeneration++;
      maiaDownloadController?.abort();
      maiaDownloadController = null;
      const session = maiaSession;
      maiaSession = null;
      const running = maiaRun;
      const loading = maiaLoading;
      autoPlayedFen = '';
      clearPrediction();
      syncEngineUi();
      setStatus('Switching to Stockfish 19…');
      Promise.allSettled([running, loading]).then(() => session?.release?.())
        .catch(error => console.warn('[Maia] Session release failed:', error))
        .finally(() => { if (engineMode === 'stockfish') { startEngine(); scan(); } });
    }
  });
  ratingEl.addEventListener('input', () => {
    maiaRating = Math.max(600, Math.min(2600, Number(ratingEl.value) || 2600));
    saveSetting('maia-rating', maiaRating);
    ratingLabelEl.textContent = String(maiaRating);
    if (engineMode === 'maia') { autoPlayedFen = ''; clearPrediction(); scan(); }
    publishStreamState();
  });
  panel.querySelector('#maia-web-retry').addEventListener('click', () => {
    if (engineMode === 'maia') void loadMaia();
    else startEngine();
  });
  autoButton.addEventListener('click', () => {
    if (engineMode !== 'maia') return;
    autoPlay = !autoPlay;
    saveSetting('maia-autoplay', autoPlay);
    syncEngineUi();
    clearTimeout(autoPlayTimer);
    autoPlayToken++;
    autoPlayedFen = '';
    maybeStartNextBotGame();
    if (autoPlay && game && shownMoves[0]) maybeAutoPlay(game.fen(), shownMoves[0].uci);
  });
  nextButton.addEventListener('click', () => {
    if (engineMode !== 'maia') return;
    autoNextBot = !autoNextBot;
    saveSetting('maia-auto-next-bot', autoNextBot);
    syncEngineUi();
    maybeStartNextBotGame();
  });
  autoSideEl.addEventListener('change', () => {
    saveSetting('maia-auto-side', autoSideEl.value);
    clearTimeout(autoPlayTimer);
    autoPlayToken++;
    autoPlayedFen = '';
    if (autoPlay && game && shownMoves[0]) maybeAutoPlay(game.fen(), shownMoves[0].uci);
  });
  panel.querySelector('#maia-web-research-run').addEventListener('click', startPostgameResearch);
  panel.querySelector('#maia-web-research-cancel').addEventListener('click', () => {
    if (!researchJob) return;
    researchJob.cancelled = true;
    researchNoteEl.textContent = 'Stopping post-game research…';
    if (researchJob.active) worker?.postMessage('stop');
    else if (!activeSearch) finishPostgameResearch();
  });
  panel.querySelector('#maia-web-research-download').addEventListener('click', () => {
    if (!researchResult) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(researchResult, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'stockfish19-postgame-research.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  depthEl.addEventListener('input', () => {
    depth = Math.max(10, Math.min(25, Number(depthEl.value) || 11));
    saveSetting('stockfish-depth', depth);
    depthLabelEl.textContent = String(depth);
    if (engineMode === 'stockfish') {
      autoPlayedFen = '';
      lastFen = '';
      if (game) requestAnalysis(game.fen());
    }
    publishStreamState();
  });
  panel.querySelector('#maia-web-rescan').addEventListener('click', () => {
    game = null; lastBoard = ''; clearPrediction(); scan();
  });
  panel.querySelector('#maia-web-flip').addEventListener('click', () => {
    flipOverride = !flipOverride;
    saveSetting('flip', flipOverride);
    drawArrows();
    autoPlayedFen = '';
    if (autoPlay && game && shownMoves[0]) maybeAutoPlay(game.fen(), shownMoves[0].uci);
  });
  panel.querySelector('#maia-web-streamer').addEventListener('click', () => {
    if (streamerMode) stopStreamerMode();
    else startStreamerMode();
  });
  panel.querySelector('#maia-web-use-fen').addEventListener('click', () => {
    if (!board) { setStatus('Open a Chess.com board first.'); return; }
    const placement = piecesFrom(board);
    const loaded = tryLoadFen(panel.querySelector('#maia-web-paste').value, placement);
    if (!loaded) { setStatus('FEN is invalid or its pieces do not match the board.'); return; }
    game = loaded; lastBoard = placement; clearPrediction(); scan();
  });

  const header = panel.querySelector('#maia-web-head');
  let drag = null;
  header.addEventListener('pointerdown', e => {
    const r = panel.getBoundingClientRect();
    drag = {dx: e.clientX - r.left, dy: e.clientY - r.top};
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener('pointermove', e => {
    if (!drag) return;
    panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - drag.dx))}px`;
    panel.style.top = `${Math.max(0, Math.min(innerHeight - header.offsetHeight, e.clientY - drag.dy))}px`;
    panel.style.right = 'auto';
  });
  header.addEventListener('pointerup', () => { drag = null; });
  header.addEventListener('pointercancel', () => { drag = null; });

  new MutationObserver(mutations => {
    if (mutations.some(m => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return el && !el.closest('#maia-web-panel, #maia-web-arrow, #maia-web-board-review');
    })) scheduleScan();
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'data-square', 'data-fen', 'data-orientation', 'aria-hidden']
  });
  addEventListener('resize', keepArrowAligned);
  addEventListener('scroll', keepArrowAligned, true);
  addEventListener('pageshow', scheduleScan);
  addEventListener('popstate', scheduleScan);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });
  setInterval(() => { if (streamerMode && streamPopup?.closed) stopStreamerMode(); }, 500);
  setInterval(scan, 300);
  depthEl.value = String(depth);
  depthLabelEl.textContent = String(depth);
  ratingEl.value = String(maiaRating);
  ratingLabelEl.textContent = String(maiaRating);
  const savedAutoSide = readSetting('maia-auto-side');
  autoSideEl.value = ['bottom', 'w', 'b'].includes(savedAutoSide) ? savedAutoSide : 'bottom';
  syncEngineUi();
  scan();
  if (engineMode === 'maia') void loadMaia();
  else startEngine();
  try {
    const savedSharedStreamer = readSetting('streamer');
    const savedStreamerState = localStorage.getItem('stockfish-streamer-active');
    if (savedSharedStreamer === 'true' || (savedSharedStreamer === null &&
        (savedStreamerState === 'true' ||
          (savedStreamerState === null && localStorage.getItem('maia-streamer-active') === 'true'))))
      setTimeout(startStreamerMode, 400);
  } catch { /* Keep manual mode available when storage is disabled. */ }
})();
