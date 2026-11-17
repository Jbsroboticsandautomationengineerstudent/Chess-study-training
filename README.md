# Chess Assistant — Maia 3 only

On-device chess move assistant for the Chess.com iOS app. Maia 3 CoreML inference suggests human-like moves and draws them as arrows on the board. Move selection, legal-move filtering, and FEN validation run locally without another chess engine.

## Features

- Maia 3 strength slider (600–2900 ELO) and up to three candidate arrows labeled with move probabilities
- Move Analysis and accuracy tracking based on Maia's value estimates
- Auto Play with adjustable delay, jitter, and optional second move selection
- Floating button, quick pause, opening detection, FEN and PGN copying, bot games, and puzzles
- Arrow thickness and opacity controls

## Install

For a rootless jailbreak, add `https://jbsroboticsandautomationengineerstudent.github.io/Chess-study-training/` to Sileo or Zebra, install the package, and respring. See the [releases page](https://github.com/Jbsroboticsandautomationengineerstudent/Chess-study-training/releases) for other distributions.

## Build

Requires Theos and an iOS SDK. The Maia 3 `maia3_5m.mlpackage` must be placed at `layout/Library/Application Support/Chess/maia3_5m.mlpackage`. For an embedded fallback, stage its `Manifest.json`, `model.mlmodel`, and `weight.bin` as `maia_mfst.json`, `maia_model.bin`, and `maia_wghts.bin` at the project root. CI downloads the model from the repository's `maia-model` release and stages both forms automatically.

```sh
make clean package FINALPACKAGE=1
```

## Project files

- `Tweak.xm`: board detection, arrows, settings, and Auto Play
- `maia.h` / `maia.mm`: Maia 3 CoreML loading and inference
- `legal.h` / `legal.cpp`: independent FEN validation and legal move generation
- `Makefile`: Theos package build
- `.github/workflows/build.yml`: model staging and package publishing

Maia 3: [CSSLab/maia3](https://github.com/CSSLab/maia3).

Using an assistant in online games may violate the game's fair-play rules.

## Web userscript research

`userscript.js` is a separate switchable Stockfish 19 / Maia 3 browser userscript. Its **Post-game move research** section accepts one completed-game PGN and evaluates the selected side's positions using Stockfish `19.0.1`, fixed depth 18, and `MultiPV` equal to the number of legal moves. The downloadable JSON contains each move's centipawn score and scaled loss `delta = phi(best) - phi(move)`, where `phi(z) = sign(z) * ln(1 + abs(z))` and scores are measured in pawns. Positions with missing full-depth scores or mate scores are marked incomplete for the move-law calculation.

The userscript saves the versioned Stockfish JavaScript and WASM files in browser IndexedDB after the first download. Reloading a page or starting a new game reuses those files, then starts a new worker and scans the board automatically. Browser storage eviction or private browsing can require another download.

The browser overlay uses the full single-threaded Stockfish 19 WASM build, with strength limiting disabled and skill level 20. Its default live-analysis depth is 11 for speed; deeper searches may find better moves and take longer. Stockfish has no single fixed Elo rating at a chosen depth. Stockfish never triggers auto-play.

**Enable human moves** switches the overlay to the 79M Maia 3 ONNX model on any scanned board. Switching to Maia terminates the Stockfish worker; switching back discards Maia's pending prediction and starts Stockfish. The model is downloaded from `cstr/maia3-onnx-int32` and cached in IndexedDB. Maia uses one inference pass, so the Stockfish depth slider is replaced with a Maia rating slider (600–2600, default 2600). This is the human rating the model imitates, not a measured engine Elo or a search-depth control. Engine selection, depth, Maia rating, auto-play preference, selected side, and arrow flip are saved across page refreshes. **Auto-play Maia** attempts the displayed Maia move on `/play/*` and `/game/*` boards; it is inactive while Stockfish is selected. On `/play/computer`, it waits roughly 1.8–7.5 seconds after prediction using a bounded, illustrative lognormal timing distribution. This delay is not a fitted human clock model; the equation's real `f0` requires measured move times and calibrated parameters. A pending move is cancelled if the position or engine changes. The move attempt tries a click and, if the position has not changed, one guarded drag attempt. Chess.com may reject synthetic input. The separate **Auto next bot game** switch is off by default and saved across refreshes. When Maia auto-play is also on, it looks for a finished bot game on `/play/computer` and clicks one visible New Game, New 1 min, Next Game, Next Bot Game, Play Again, or Rematch control once. It does not click next-game controls on human match routes. Using an engine or automation in games against people violates Chess.com's fair-play rules.

The arrow's destination square shows a percentage for the selected move. For Maia, it is the model's softmax probability over legal moves. For Stockfish, it is the side-to-move's expected game score, calculated from its WDL output as `100 × (win + draw / 2) / (win + draw + loss)`. These are different measures, not a property of the square itself. If Stockfish has no WDL or forced-mate score, the script leaves the percentage blank rather than deriving one from centipawns.

On bot and analysis boards, the overlay shows up to three current legal suggestions as separate arrows and move-list rows. Maia ranks them by model probability, normalized over **all** legal moves; blue shades distinguish ranks. Precision search requests up to three MultiPV lines and only shows alternatives that reached the best line's completed depth. Its arrow labels are expected game scores when WDL is available, and its category colors use same-position centipawn loss. These scores are not move probabilities. A reviewed played move may add another colored arrow. The streamer mini-board mirrors the arrows. Auto-play still uses rank #1 only. Other pages retain one suggestion arrow.

After **Post-game move research** completes, a bot or analysis board showing a matching reviewed FEN draws one color-coded arrow for each move-quality category actually represented among that position's legal moves. The review card lists the corresponding moves. This uses Stockfish's fixed-depth evaluation of every legal move and remains visible when Human style is selected, without running both engines simultaneously. It cannot show ten categories at every position: categories with no qualifying move have no arrow. Brilliant and Book require evidence this project does not have. On a board without matching completed research, the ordinary ranked suggestions are shown.

### Board Studio move review

On bot and analysis boards, the overlay shows a review card and a compact score above the board when it has evaluated moves. Post-game research accepts a PGN for both sides and searches every legal move at fixed depth 18. A reviewed move's centipawn loss is the best legal score minus that move's score from the same position. This project's review accuracy is the mean of `100 × exp(-max(0, lossCp) / 150)` over fully evaluated moves. It is **not** Chess.com's proprietary accuracy score. Moves with incomplete searches or mate scores are left unclassified.

The review labels use explicit centipawn-loss thresholds: Best (≤10), Excellent (≤35), Good (≤80), Inaccuracy (≤160), Mistake (≤300), and Blunder (>300). Great requires the played move to be best, at least 150 centipawns ahead of the second choice, with the second choice below −100 centipawns. Miss marks a 160–300 centipawn loss when a position of at least +150 centipawns drops to 0 or worse. Brilliant and Book remain unassigned because the script has neither validated sacrifice analysis nor an opening book. Their legend entries are shown as unavailable rather than inferred from a single engine score.

On `/play/computer`, Precision style also updates an *estimated* running score after a move only when searches completed both before and after it. The post-move score is converted to the prior player's perspective; a played move that matched the prior best move receives zero loss. This faster two-position estimate can differ from the fixed-depth, all-legal-moves post-game result. The score pauses while Human style is selected because the engines remain exclusive. Colored review arrows appear on `/analysis` when the visible FEN matches a reviewed position; the ordinary prediction arrow remains available in either style. These review cues are not added to live human match pages.

The optional `s` and `c` fields must contain values **refitted on honest reference games analyzed with this same Stockfish setup**. When supplied, the script solves `sum(p0 ^ w_i) = 1` with Newton's method (and a log-space safeguard) and exports the resulting move probabilities. The older published fit values are not used as defaults. Without a fitted joint alternative, clock model, rating corridor, and held-out calibration, the unified `E_N` statistic and statistical flag are intentionally unavailable. The attached research paper states that its equations have not been fitted to or tested on games.
