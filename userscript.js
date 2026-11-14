// ==UserScript==
// @name         Maia 3 Chess Board Assistant
// @namespace    https://github.com/Jbsroboticsandautomationengineerstudent/Chess-study-training
// @version      0.2.0
// @description  Local Maia ONNX move probabilities on Chess.com boards
// @match        https://www.chess.com/play/*
// @match        https://www.chess.com/analysis*
// @run-at       document-idle
// @inject-into  content
// @require      https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.min.js
// @connect      jbsroboticsandautomationengineerstudent.github.io
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/*
 * Model contract (the model is published from web/models/maia3_5m.onnx):
 *   tokens      float32 [1,64,96]
 *   self_elo    int32 or int64 [1]
 *   oppo_elo    int32 or int64 [1]
 *   logits_move float32 [1,4352] (move_logits is also accepted)
 *   logits_value float32 [1,3] (loss, draw, win for the side to move)
 * The token and move-index mappings mirror maia.mm. A stock Maia .pt checkpoint
 * or CoreML .mlpackage cannot be renamed to .onnx; export a compatible model.
 */
(async () => {
  'use strict';

  if (window.top !== window || document.getElementById('maia-web-panel')) return;
  const MODEL_URL = 'https://jbsroboticsandautomationengineerstudent.github.io/Chess-study-training/models/maia3_5m.onnx';
  const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
  const ChessClass = typeof Chess !== 'undefined' ? Chess : window.Chess;
  const ortApi = typeof ort !== 'undefined' ? ort : window.ort;
  if (!ChessClass || !ortApi) {
    console.error('[Maia] chess.js or onnxruntime-web did not load. Check the userscript manager and CDN access.');
    return;
  }

  const savedElo = Number(localStorage.getItem('maia-web-elo'));
  let elo = [1100, 1300, 1500, 1700, 1900, 2100, 2300].includes(savedElo) ? savedElo : 1500;
  let board = null;
  let game = null;
  let session = null;
  let modelPromise = null;
  let modelError = '';
  let lastFen = '';
  let lastBoard = '';
  let missedBoard = '';
  let missedCount = 0;
  let inferenceId = 0;
  let scanTimer = 0;
  let flipOverride = false;
  let shownMoves = [];
  const seenPositions = new Map();

  const style = document.createElement('style');
  style.textContent = `
    #maia-web-panel{position:fixed;top:90px;right:16px;z-index:2147483646;
      width:min(290px,calc(100vw - 24px));box-sizing:border-box;background:#17212d;
      color:#f7f9fb;border:1px solid #50657b;border-radius:12px;
      box-shadow:0 8px 28px #0008;font:13px/1.4 system-ui,-apple-system,sans-serif}
    #maia-web-panel *{box-sizing:border-box}
    #maia-web-head{padding:10px 12px;background:#26394c;border-radius:11px 11px 0 0;
      font-weight:700;cursor:grab;touch-action:none;user-select:none;display:flex;justify-content:space-between}
    #maia-web-panel .body{padding:10px 12px}
    #maia-web-panel .row{display:flex;align-items:center;gap:7px;margin-bottom:7px}
    #maia-web-panel select,#maia-web-panel input,#maia-web-panel button{
      color:#fff;background:#33485d;border:1px solid #708296;border-radius:5px;padding:4px 6px;font:inherit}
    #maia-web-panel select{flex:1} #maia-web-panel button{cursor:pointer}
    #maia-web-panel input{width:100%;font:11px/1.4 ui-monospace,monospace}
    #maia-web-status{color:#c6d5e4;min-height:32px;margin:5px 0;white-space:pre-wrap}
    #maia-web-moves{margin:6px 0 8px;padding-left:21px;font:14px/1.6 ui-monospace,monospace}
    #maia-web-fen{overflow-wrap:anywhere;color:#a9b9c9;font:10px/1.3 ui-monospace,monospace}
    #maia-web-value{margin:7px 0 9px}
    #maia-web-value-label{display:flex;justify-content:space-between;margin-bottom:3px;color:#dbe7f1;font-size:11px}
    #maia-web-value-bar{display:flex;height:12px;overflow:hidden;border:1px solid #708296;border-radius:5px;background:#33485d}
    #maia-web-value-bar span{height:100%;min-width:0}
    #maia-web-white{background:#f5f5ed} #maia-web-draw{background:#cfb951} #maia-web-black{background:#242b35}
    #maia-web-arrow{position:fixed;z-index:2147483645;pointer-events:none;overflow:visible}
    @media(max-width:600px){#maia-web-panel{top:68px;right:8px}}
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'maia-web-panel';
  panel.innerHTML = `
    <div id="maia-web-head"><span>Maia 3</span><span>drag</span></div>
    <div class="body">
      <div class="row"><label for="maia-web-elo">ELO</label>
        <select id="maia-web-elo"><option>1100</option><option>1300</option><option>1500</option><option>1700</option><option>1900</option><option>2100</option><option>2300</option></select>
        <button id="maia-web-flip" title="Reverse arrow orientation">Flip</button></div>
      <div id="maia-web-status">Finding board…</div>
      <ol id="maia-web-moves"></ol>
      <div id="maia-web-value"><div id="maia-web-value-label"><span>White win —</span><span>Draw —</span><span>Black win —</span></div>
        <div id="maia-web-value-bar" role="img" aria-label="Win probabilities"><span id="maia-web-white"></span><span id="maia-web-draw"></span><span id="maia-web-black"></span></div></div>
      <div class="row"><button id="maia-web-retry">Load model</button>
        <button id="maia-web-rescan">Rescan board</button></div>
      <div class="row"><input id="maia-web-paste" placeholder="Paste full FEN if joining midgame" aria-label="Full FEN"></div>
      <div class="row"><button id="maia-web-use-fen">Use FEN</button></div>
      <div id="maia-web-fen"></div>
    </div>`;
  document.documentElement.appendChild(panel);
  const statusEl = panel.querySelector('#maia-web-status');
  const movesEl = panel.querySelector('#maia-web-moves');
  const fenEl = panel.querySelector('#maia-web-fen');
  const eloEl = panel.querySelector('#maia-web-elo');
  const valueLabels = panel.querySelectorAll('#maia-web-value-label span');
  const valueSegments = ['#maia-web-white', '#maia-web-draw', '#maia-web-black'].map(selector => panel.querySelector(selector));
  eloEl.value = String(elo);

  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.id = 'maia-web-arrow';
  arrow.setAttribute('viewBox', '0 0 100 100');
  document.documentElement.appendChild(arrow);
  arrow.style.display = 'none';
  const svgNS = 'http://www.w3.org/2000/svg';

  function setStatus(message) {
    if (statusEl.textContent !== message) statusEl.textContent = message;
  }
  function clearPrediction() {
    inferenceId++;
    lastFen = '';
    movesEl.replaceChildren();
    shownMoves = [];
    valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} —`; });
    valueSegments.forEach(segment => { segment.style.width = '0%'; });
    arrow.replaceChildren();
    arrow.style.display = 'none';
  }
  function keepArrowAligned() {
    if (!board || arrow.style.display === 'none') return;
    const r = board.getBoundingClientRect();
    arrow.style.left = `${r.left}px`;
    arrow.style.top = `${r.top}px`;
    arrow.style.width = `${r.width}px`;
    arrow.style.height = `${r.height}px`;
  }
  function isBlackView() {
    if (!board) return false;
    const marked = board.closest('.flipped, .orientation-black, [data-orientation="black"]');
    return Boolean(marked) !== flipOverride;
  }
  function squarePoint(square) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const black = isBlackView();
    return {x: (black ? 7 - file : file) * 12.5 + 6.25,
            y: (black ? rank : 7 - rank) * 12.5 + 6.25};
  }
  function drawArrows(moves = shownMoves) {
    arrow.replaceChildren();
    if (!board || !moves.length) { arrow.style.display = 'none'; return; }
    const colors = ['#24dc83', '#71e5a8', '#b8efd1'];
    const opacities = [1, 0.78, 0.58];
    const destinationCounts = new Map();
    for (const move of moves) destinationCounts.set(move.uci.slice(2, 4), (destinationCounts.get(move.uci.slice(2, 4)) || 0) + 1);
    const destinationSlots = new Map();
    moves.forEach((move, index) => {
      const a = squarePoint(move.uci.slice(0, 2));
      const b = squarePoint(move.uci.slice(2, 4));
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (!length) return;
      const ux = dx / length, uy = dy / length;
      const endX = b.x - ux * 3.2, endY = b.y - uy * 3.2;
      const line = document.createElementNS(svgNS, 'line');
      for (const [name, value] of Object.entries({x1: a.x, y1: a.y, x2: endX, y2: endY, stroke: colors[index], 'stroke-width': 1.6 - index * 0.2, 'stroke-linecap': 'round', opacity: opacities[index]})) line.setAttribute(name, value);
      arrow.appendChild(line);
      const tip = document.createElementNS(svgNS, 'polygon');
      const wingX = -uy * 2.1, wingY = ux * 2.1;
      tip.setAttribute('points', `${b.x},${b.y} ${b.x - ux * 4.3 + wingX},${b.y - uy * 4.3 + wingY} ${b.x - ux * 4.3 - wingX},${b.y - uy * 4.3 - wingY}`);
      tip.setAttribute('fill', colors[index]); tip.setAttribute('opacity', opacities[index]);
      arrow.appendChild(tip);
      const dest = move.uci.slice(2, 4);
      const slot = destinationSlots.get(dest) || 0;
      destinationSlots.set(dest, slot + 1);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', b.x);
      label.setAttribute('y', b.y + 4.3 - (destinationCounts.get(dest) - 1 - slot) * 3.2);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '2.8');
      label.setAttribute('font-weight', '700');
      label.setAttribute('font-family', 'system-ui,sans-serif');
      label.setAttribute('fill', colors[index]);
      label.setAttribute('stroke', '#10251b');
      label.setAttribute('stroke-width', '0.8');
      label.setAttribute('paint-order', 'stroke');
      label.textContent = `${move.percent.toFixed(1)}%`;
      arrow.appendChild(label);
    });
    arrow.style.display = 'block';
    keepArrowAligned();
  }

  // The site's class square-XY uses file X and rank Y, independent of rotation.
  function piecesFrom(boardElement) {
    const pieces = new Map();
    for (const el of boardElement.querySelectorAll('.piece')) {
      const classes = Array.from(el.classList);
      const piece = classes.find(c => /^[wb][prnbqk]$/.test(c));
      const square = classes.map(c => /^square-([1-8])([1-8])$/.exec(c)).find(Boolean);
      if (!piece || !square) continue;
      if (pieces.has(`${square[1]}${square[2]}`)) return null;
      pieces.set(`${square[1]}${square[2]}`, piece);
    }
    if (!pieces.size || pieces.size > 32) return null;
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
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('wc-chess-board, chess-board, #board-single, #board-analysis, .board, [data-cy="board"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 160 || r.height < 160 || !piecesFrom(el)) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }
  function tryLoadFen(fen, placement) {
    if (typeof fen !== 'string' || !/^[prnbqkPRNBQK1-8/]+ [wb] /.test(fen.trim())) return null;
    const candidate = new ChessClass();
    try {
      if (!candidate.load(fen.trim())) return null;
      return candidate.fen().split(' ')[0] === placement ? candidate : null;
    } catch { return null; }
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

  function scan() {
    const found = findBoard();
    if (found !== board) {
      board = found;
      if (board && shownMoves.length) drawArrows();
      else arrow.style.display = 'none';
    }
    if (!board) { setStatus('Waiting for Chess.com board…'); return; }
    const placement = piecesFrom(board);
    if (!placement) { setStatus('Waiting for pieces…'); return; }
    const fromSite = siteFen(placement);
    if (placement !== lastBoard || !game || (fromSite && fromSite.fen() !== game.fen())) {
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
      game = next; lastBoard = placement; clearPrediction();
      rememberPosition(game);
    }
    if (!game) return;
    const fen = game.fen();
    if (fenEl.textContent !== fen) fenEl.textContent = fen;
    if (session) void predict(fen);
    else if (!modelPromise) setStatus(modelError || 'Board ready. Load a compatible Maia ONNX model.');
    keepArrowAligned();
  }
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  function downloadModel(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer',
        onload: r => r.status === 200 ? resolve(r.response) : reject(new Error(`Model HTTP ${r.status}`)),
        onerror: () => reject(new Error('Model download failed'))
      }));
    }
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(`Model HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }
  async function loadModel() {
    if (modelPromise) return modelPromise;
    modelError = '';
    setStatus('Downloading Maia ONNX model…');
    modelPromise = (async () => {
      ortApi.env.wasm.wasmPaths = ORT_DIST;
      ortApi.env.wasm.numThreads = 1; // Safari does not always permit threaded WASM.
      const bytes = await downloadModel(MODEL_URL);
      session = await ortApi.InferenceSession.create(bytes, {executionProviders: ['wasm']});
      for (const name of ['tokens', 'self_elo', 'oppo_elo']) {
        if (!session.inputNames.includes(name)) throw new Error(`ONNX input '${name}' missing`);
      }
      if (!session.outputNames.some(name => name === 'logits_move' || name === 'move_logits'))
        throw new Error("ONNX output 'logits_move' or 'move_logits' missing");
      setStatus('Maia model loaded.');
      lastFen = '';
      scan();
    })().catch(error => {
      session = null;
      modelError = `Model unavailable: ${error.message}`;
      setStatus(modelError);
    }).finally(() => { modelPromise = null; });
    return modelPromise;
  }

  function boardTokens(fen) {
    const result = new Float32Array(64 * 96);
    const [placement, side] = fen.split(' ');
    const ranks = placement.split('/');
    const channel = {p: 0, n: 1, b: 2, r: 3, q: 4, k: 5};
    for (let row = 0; row < 8; row++) {
      let file = 0;
      for (const c of ranks[row]) {
        if (/^[1-8]$/.test(c)) { file += Number(c); continue; }
        const rank = 7 - row;
        const sq = rank * 8 + file++;
        const blackPiece = c === c.toLowerCase();
        const mappedSq = side === 'b' ? sq ^ 56 : sq;
        const mappedBlack = side === 'b' ? !blackPiece : blackPiece;
        const ch = channel[c.toLowerCase()] + (mappedBlack ? 6 : 0);
        for (let repeat = 0; repeat < 8; repeat++) result[mappedSq * 96 + repeat * 12 + ch] = 1;
      }
    }
    return result;
  }
  function mirrorSquare(square) { return `${square[0]}${9 - Number(square[1])}`; }
  function moveIndex(move, black) {
    const from = black ? mirrorSquare(move.from) : move.from;
    const to = black ? mirrorSquare(move.to) : move.to;
    const ff = from.charCodeAt(0) - 97, fr = Number(from[1]) - 1;
    const tf = to.charCodeAt(0) - 97, tr = Number(to[1]) - 1;
    if (move.promotion) {
      const pi = 'qrbn'.indexOf(move.promotion);
      if (pi < 0 || fr !== 6 || tr !== 7) return -1;
      return 4096 + ff * 32 + tf * 4 + pi;
    }
    return (fr * 8 + ff) * 64 + (tr * 8 + tf);
  }
  function eloTensor(name) {
    const inputIndex = session.inputNames.indexOf(name);
    const type = session.inputMetadata?.[inputIndex]?.type || 'tensor(int32)';
    if (type === 'int64' || type === 'tensor(int64)')
      return new ortApi.Tensor('int64', BigInt64Array.of(BigInt(elo)), [1]);
    if (type === 'int32' || type === 'tensor(int32)')
      return new ortApi.Tensor('int32', Int32Array.of(elo), [1]);
    throw new Error(`${name} must be int32 or int64, got ${type}`);
  }
  function showValue(logits, blackToMove) {
    if (!logits || logits.length !== 3 || !Array.from(logits).every(Number.isFinite)) {
      valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} —`; });
      valueSegments.forEach(segment => { segment.style.width = '0%'; });
      return;
    }
    const max = Math.max(...logits);
    const weights = Array.from(logits, value => Math.exp(value - max));
    const total = weights.reduce((a, b) => a + b, 0);
    const [loss, draw, win] = weights.map(value => 100 * value / total);
    const percentages = blackToMove ? [loss, draw, win] : [win, draw, loss];
    valueLabels.forEach((label, index) => { label.textContent = `${['White win', 'Draw', 'Black win'][index]} ${percentages[index].toFixed(1)}%`; });
    valueSegments.forEach((segment, index) => { segment.style.width = `${percentages[index]}%`; });
    panel.querySelector('#maia-web-value-bar').setAttribute('aria-label', `White win ${percentages[0].toFixed(1)}%, draw ${percentages[1].toFixed(1)}%, black win ${percentages[2].toFixed(1)}%`);
  }
  async function predict(fen) {
    if (!session || !game || fen === lastFen) return;
    lastFen = fen;
    const myId = ++inferenceId;
    setStatus('Maia is evaluating…');
    try {
      const legal = game.moves({verbose: true});
      if (!legal.length) { setStatus('No legal moves.'); return; }
      const feeds = {
        tokens: new ortApi.Tensor('float32', boardTokens(fen), [1, 64, 96]),
        self_elo: eloTensor('self_elo'), oppo_elo: eloTensor('oppo_elo')
      };
      const output = await session.run(feeds);
      if (myId !== inferenceId) return;
      const logits = (output.logits_move || output.move_logits)?.data;
      if (!logits || logits.length < 4352) throw new Error('Move logits must contain 4352 values');
      const black = game.turn() === 'b';
      const candidates = legal.map(move => {
        const index = moveIndex(move, black);
        return {uci: `${move.from}${move.to}${move.promotion || ''}`, logit: index < 0 ? NaN : Number(logits[index])};
      }).filter(x => Number.isFinite(x.logit));
      if (!candidates.length) throw new Error('No legal moves mapped to model logits');
      const max = Math.max(...candidates.map(x => x.logit));
      const sum = candidates.reduce((acc, x) => acc + Math.exp(x.logit - max), 0);
      candidates.sort((a, b) => b.logit - a.logit);
      shownMoves = candidates.slice(0, 3).map(candidate => ({uci: candidate.uci, percent: 100 * Math.exp(candidate.logit - max) / sum}));
      movesEl.replaceChildren();
      for (const candidate of shownMoves) {
        const li = document.createElement('li');
        li.textContent = `${candidate.uci} (${candidate.percent.toFixed(1)}%)`;
        movesEl.appendChild(li);
      }
      drawArrows();
      showValue(output.logits_value?.data, black);
      setStatus(`Maia ${elo} · ${black ? 'Black' : 'White'} to move`);
    } catch (error) {
      if (myId !== inferenceId) return;
      lastFen = '';
      clearPrediction();
      setStatus(`Inference failed: ${error.message}`);
    }
  }

  eloEl.addEventListener('change', () => {
    elo = Number(eloEl.value);
    localStorage.setItem('maia-web-elo', String(elo));
    lastFen = '';
    scan();
  });
  panel.querySelector('#maia-web-retry').addEventListener('click', loadModel);
  panel.querySelector('#maia-web-rescan').addEventListener('click', () => {
    game = null; lastBoard = ''; clearPrediction(); scan();
  });
  panel.querySelector('#maia-web-flip').addEventListener('click', () => {
    flipOverride = !flipOverride;
    drawArrows();
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
      return el && !el.closest('#maia-web-panel, #maia-web-arrow');
    })) scheduleScan();
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'data-fen', 'data-orientation', 'aria-hidden']
  });
  addEventListener('resize', keepArrowAligned);
  addEventListener('scroll', keepArrowAligned, true);
  addEventListener('pageshow', scheduleScan);
  addEventListener('popstate', scheduleScan);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });
  setInterval(scan, 1000);
  scan();
  void loadModel();
})();
