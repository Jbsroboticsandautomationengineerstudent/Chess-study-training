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
