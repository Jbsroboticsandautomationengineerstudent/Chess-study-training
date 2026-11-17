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

`userscript.js` is a separate Stockfish 19 browser userscript. Its **Post-game move research** section accepts one completed-game PGN and evaluates the selected side's positions using Stockfish `19.0.1`, fixed depth 18, and `MultiPV` equal to the number of legal moves. The downloadable JSON contains each move's centipawn score and scaled loss `delta = phi(best) - phi(move)`, where `phi(z) = sign(z) * ln(1 + abs(z))` and scores are measured in pawns. Positions with missing full-depth scores or mate scores are marked incomplete for the move-law calculation.

The userscript saves the versioned Stockfish JavaScript and WASM files in browser IndexedDB after the first download. Reloading a page or starting a new game reuses those files, then starts a new worker and scans the board automatically. Browser storage eviction or private browsing can require another download.

The browser overlay uses the full single-threaded Stockfish 19 WASM build, with strength limiting disabled and skill level 20. Its default live-analysis depth is 11 for speed; deeper searches may find better moves and take longer. Stockfish has no single fixed Elo rating at a chosen depth. The **Auto-play bots** switch is off by default and is available only on Chess.com's `/play/computer` bot page. It attempts the displayed best move once per position for the selected side and reports when the board does not accept the synthetic click events. It does not run on live match or review pages.

**Enable human moves** switches the bot/analysis overlay to the 79M Maia 3 ONNX model. Switching to Maia stops Stockfish; switching back discards Maia's pending prediction and restarts Stockfish. The model is downloaded from `cstr/maia3-onnx-int32` and cached in IndexedDB. Maia uses one inference pass, so the Stockfish depth slider is replaced with a Maia rating slider (600–2600, default 2600). This is the human rating the model imitates, not a measured engine Elo or a search-depth control. Maia hints are limited to `/play/computer` and `/analysis` pages. Bot auto-play can use the selected engine; the script does not auto-play against human opponents. The bot move path tries a click and, if the position has not changed, one guarded drag attempt; Chess.com may reject synthetic input.

The optional `s` and `c` fields must contain values **refitted on honest reference games analyzed with this same Stockfish setup**. When supplied, the script solves `sum(p0 ^ w_i) = 1` with Newton's method (and a log-space safeguard) and exports the resulting move probabilities. The older published fit values are not used as defaults. Without a fitted joint alternative, clock model, rating corridor, and held-out calibration, the unified `E_N` statistic and statistical flag are intentionally unavailable. The attached research paper states that its equations have not been fitted to or tested on games.
