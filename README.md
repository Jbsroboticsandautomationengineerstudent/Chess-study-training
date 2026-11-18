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

The browser overlay uses the full single-threaded Stockfish 19 WASM build. Its default live-analysis depth is 11 for speed; deeper searches may find better moves and take longer. The Stockfish rating slider runs from 600 to 3190, default 3190. [Stockfish 19's source](https://github.com/official-stockfish/Stockfish/blob/sf_19/src/search.h) sets the native `UCI_Elo` range to **1320–3190**. At 1320 and above the script uses native `UCI_Elo`. Below 1320 it uses the experimental Lichess 5+0 move-choice fit described below, with full-strength Stockfish scores at fixed depth 6. The depth slider is disabled for this fitted range. Post-game research disables strength limiting so its fixed-depth evaluations remain full-strength.

**Enable human moves** switches the overlay to the 79M Maia 3 ONNX model on any scanned board. Switching to Maia terminates the Stockfish worker; switching back discards Maia's pending prediction and starts Stockfish. The model is downloaded from `cstr/maia3-onnx-int32` and cached in IndexedDB. Maia uses one inference pass, so the Stockfish depth and target-Elo sliders are replaced with a Maia rating slider (600–2600, default 2600). This is the human rating the model imitates, not a measured engine Elo or a search-depth control. Engine selection, depth, ratings, auto-play preference, selected side, and arrow flip are saved across page refreshes. **Auto-play** attempts the selected engine's planned legal move on recognized play, game, or analysis boards when it is that side's turn. On `/play/computer`, it waits roughly 1.8–7.5 seconds after prediction using a bounded, illustrative lognormal timing distribution. This delay is not a fitted human clock model; the equation's real `f0` requires measured move times and calibrated parameters. A pending move is cancelled if the position or engine changes. The move attempt tries a click and, if the position has not changed, one guarded drag attempt. Chess.com may reject synthetic input. The separate **Auto next bot game** switch is off by default and saved across refreshes. When auto-play is on, it looks for a finished bot game on `/play/computer` and clicks one visible New Game, New 1 min, Next Game, Next Bot Game, Play Again, or Rematch control once. It does not click next-game controls on human match routes. Using an engine or automation in games against people violates Chess.com's fair-play rules.

At native ratings, Stockfish auto-play follows the existing repeating **six-own-turn cycle**: turn 1 chooses a random legal move from a small curated opening list when the game is still on its first move (later cycle restarts use the top search move); turns 2–3 sample from moves classified Best, Great, Excellent, or Good; turns 4–6 sample actual Miss or Blunder candidates and the lowest-ranked legal moves. Below 1320 the six-move cycle is replaced by a probability distribution fitted to Lichess human move choices. If full-depth scores for every legal move are unavailable, it falls back to the strongest search move and says so. The blue arrow marks that strongest move; a distinct fitted choice is also drawn with its evaluated move-quality color and shown in the panel.

Board arrows appear only for the selected side (bottom side, White, or Black). The dark blue `#00008A` arrow is the selected engine's rank-one move. If a category arrow is the same move, only the blue arrow is drawn. Stockfish arrow labels show the actual UCI evaluation in centipawns from the player-to-move's perspective at the searched depth, such as `+34 cp`, or a mate score such as `M+2`; a missing score is left blank. This is a position and move evaluation, not a measured property of the destination square or a guaranteed perfect score. Maia cannot output centipawns: `p` labels are softmax move probabilities, while `M` labels are Maia's modeled expected outcome after a candidate move. The separate win bar uses Stockfish WDL estimates or Maia value logits, according to the active engine.

On every Chess.com route where the scanner finds a valid board, the overlay shows ten move-quality rows with color-matched icons: Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder, and Brilliant. Rows show a legal move only when that category is supported by an evaluation of the current position; other rows explain why no move is shown. The live Stockfish Book row uses the small curated first-move list; this is not a full opening database. On the selected side's turn, the main board draws the blue best-move arrow plus any distinct category arrows. Maia's blue policy move is available immediately; Maia then checks the first ten successor positions and **every remaining legal move** with its value output, reclassifies against the highest value among all legal moves, and adds a Blunder arrow only if a legal move truly exceeds the project's model-score-loss threshold. Checking every move may be very slow on CPU, and a position with no qualifying Blunder will not show one. These are Maia outcome estimates, not Chess.com's official classifications or Stockfish centipawn evaluations. The category badge colors approximate the supplied Game Review image; the SVG vectors are bundled in the script, so no external icon host is required. Precision search requests one MultiPV line per legal move on every recognized board. Once all lines have centipawn scores at a common depth of at least 4, category arrows update as the search deepens. The category thresholds and any review accuracy remain this project's estimates, not Chess.com's scores. The engines remain exclusive. The streamer mini-board shows only the best suggestion. Maia auto-play uses rank #1; Stockfish auto-play uses its fitted choice below 1320 and its cycle at native ratings.

### Lichess 5+0 low-rating sample

The experimental settings below 1320 were fitted from one **168 MB** January 2024 shard of the [Lichess standard chess games dataset](https://huggingface.co/datasets/Lichess/standard-chess-games). The script in `tools/calibrate_lichess.py` filters human rated 5+0 blitz games, excludes players with rating changes above 40 points, samples at most 300 player-games per 100-point rating band, and analyzes one position per sampled game with the [official Stockfish 19](https://github.com/official-stockfish/Stockfish/releases/tag/sf_19) binary at depth 6 and MultiPV equal to the number of legal moves. It fits `P(move) ∝ exp(-β × min(8, centipawn_loss / 100))`; β values and held-out negative log likelihoods are saved in `web/models/lichess-5plus0-stockfish19-depth6.json` and embedded in the userscript. Every band scored better than uniform legal-move selection on the held-out players in this shard.

This is a **small pilot fit**, not a measured playing Elo or a complete human behavior model. Different time controls, months, player pools, game phases, and Chess.com ratings require their own validation. The browser WASM build can also produce different scores from the desktop binary used for fitting; live browser behavior has not been independently validated. The slider interpolates the fitted β values between bands; neighboring bands can be similar because the sample is limited. To reproduce with the same shard, install `tools/requirements-calibration.txt`, download `data/year=2024/month=01/train-00000-of-00421.parquet` from the dataset, and run `python tools/calibrate_lichess.py --parquet PATH_TO_SHARD --engine PATH_TO_OFFICIAL_STOCKFISH_19_EXE --output web/models/lichess-5plus0-stockfish19-depth6.json --depth 6 --per-band 300`.

The [upstream Maia 3 UCI integration](https://github.com/CSSLab/maia3/blob/main/maia3/uci.py) also evaluates candidate successor positions and inverts their side-to-move WDL result back to the player who chose the move. This script follows that perspective convention while analyzing all legal moves in the current position.

After **Post-game move research** completes, any supported board showing a matching reviewed FEN can use its fixed-depth result instead of the provisional live result. On bot and analysis routes, the review card also lists the corresponding moves. Ten rows are always shown, but a position cannot have ten different categories unless ten distinct moves actually qualify. Brilliant remains unavailable without validated sacrifice analysis; post-game Book classification still needs a proper opening database. Maia value categories use the successor model's Loss/Draw/Win output and project-defined thresholds across all evaluated legal moves. If that value output is unavailable, the blue policy arrow remains, without unverified category arrows.

### Board Studio move review

On bot and analysis boards, the overlay shows a review card and a compact score above the board when it has evaluated moves. Post-game research accepts a PGN for both sides and searches every legal move at fixed depth 18. A reviewed move's centipawn loss is the best legal score minus that move's score from the same position. This project's review accuracy is the mean of `100 × exp(-max(0, lossCp) / 150)` over fully evaluated moves. It is **not** Chess.com's proprietary accuracy score. Moves with incomplete searches or mate scores are left unclassified.

The review labels use explicit centipawn-loss thresholds: Best (≤10), Excellent (≤35), Good (≤80), Inaccuracy (≤160), Mistake (≤300), and Blunder (>300). Great requires the played move to be best, at least 150 centipawns ahead of the second choice, with the second choice below −100 centipawns. Miss marks a 160–300 centipawn loss when a position of at least +150 centipawns drops to 0 or worse. Brilliant and Book remain unassigned because the script has neither validated sacrifice analysis nor an opening book. Their legend entries are shown as unavailable rather than inferred from a single engine score.

On `/play/computer`, Precision style also updates an *estimated* running score after a move only when searches completed both before and after it. The post-move score is converted to the prior player's perspective; a played move that matched the prior best move receives zero loss. This faster two-position estimate can differ from the fixed-depth, all-legal-moves post-game result. The score pauses while Human style is selected because the engines remain exclusive. Colored review arrows appear on `/analysis` when the visible FEN matches a reviewed position; the ordinary prediction arrow remains available in either style. These review cues are not added to live human match pages.

The optional `s` and `c` fields must contain values **refitted on honest reference games analyzed with this same Stockfish setup**. When supplied, the script solves `sum(p0 ^ w_i) = 1` with Newton's method (and a log-space safeguard) and exports the resulting move probabilities. The older published fit values are not used as defaults. Without a fitted joint alternative, clock model, rating corridor, and held-out calibration, the unified `E_N` statistic and statistical flag are intentionally unavailable. The attached research paper states that its equations have not been fitted to or tested on games.
