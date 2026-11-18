"""Fit a small, auditable move-choice model from Lichess rated blitz games.

Input is one Parquet shard from Lichess/standard-chess-games. The model is
conditional on Stockfish 19 scores at one fixed depth; it is not an Elo rating
for Stockfish and is not a model of Chess.com ratings.
"""

import argparse
from collections import defaultdict
import hashlib
import io
import json
import math
from pathlib import Path
import random
import sys

import chess.engine
import chess.pgn
import pyarrow.parquet as parquet


BANDS = [(low, min(low + 99, 1320)) for low in range(600, 1321, 100)]
REQUIRED = [
    "Event", "Site", "White", "Black", "WhiteElo", "BlackElo", "WhiteRatingDiff",
    "BlackRatingDiff", "WhiteTitle", "BlackTitle", "TimeControl", "movetext",
]


def band_for(rating):
    if rating is None or not 600 <= rating <= 1320:
        return None
    return min(1300, rating // 100 * 100)


def sample_games(path, per_band, seed):
    """Reservoir sample one player's game per band without loading all rows."""
    rng = random.Random(seed)
    reservoirs = defaultdict(list)
    seen = defaultdict(int)
    source = parquet.ParquetFile(path)
    missing = set(REQUIRED) - set(source.schema.names)
    if missing:
        raise ValueError(f"Parquet file is missing columns: {sorted(missing)}")
    for batch in source.iter_batches(batch_size=4096, columns=REQUIRED):
        data = batch.to_pydict()
        for i in range(batch.num_rows):
            if data["TimeControl"][i] != "300+0" or "Blitz" not in (data["Event"][i] or ""):
                continue
            # Neither side may be a Lichess bot account.
            if data["WhiteTitle"][i] == "BOT" or data["BlackTitle"][i] == "BOT":
                continue
            game_text = data["movetext"][i]
            if not game_text:
                continue
            for side in ("White", "Black"):
                rating = data[f"{side}Elo"][i]
                band = band_for(rating)
                rating_diff = data[f"{side}RatingDiff"][i]
                if band is None or rating_diff is None or abs(rating_diff) > 40:
                    continue
                seen[band] += 1
                item = (data["Site"][i], side, rating, data[side][i], game_text)
                chosen = reservoirs[band]
                if len(chosen) < per_band:
                    chosen.append(item)
                else:
                    index = rng.randrange(seen[band])
                    if index < per_band:
                        chosen[index] = item
    return reservoirs, seen


def sample_position(item, seed):
    site, side, rating, player, movetext = item
    game = chess.pgn.read_game(io.StringIO(movetext))
    if not game or game.errors:
        return None
    board = game.board()
    positions = []
    color = chess.WHITE if side == "White" else chess.BLACK
    for ply, move in enumerate(game.mainline_moves()):
        if board.turn == color and 8 <= ply <= 60 and board.legal_moves.count() >= 2:
            positions.append((board.copy(), move))
        board.push(move)
    if not positions:
        return None
    # Pick one position per player-game to reduce within-game dependence.
    rng = random.Random(f"{seed}:{site}:{side}")
    board, move = rng.choice(positions)
    return board, move


def score_position(engine, board, played, depth):
    legal_count = board.legal_moves.count()
    analysis = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=legal_count)
    values = {}
    for line in analysis:
        pv = line.get("pv")
        score = line.get("score")
        if pv and score:
            cp = score.pov(board.turn).score(mate_score=100000)
            if cp is not None:
                values[pv[0].uci()] = cp
    if len(values) != legal_count or played.uci() not in values:
        return None
    best = max(values.values())
    # Clipping keeps forced mates from dominating a simple score-loss model.
    losses = [min(800, max(0, best - cp)) / 100 for cp in values.values()]
    played_loss = min(800, max(0, best - values[played.uci()])) / 100
    return losses, played_loss


def logsumexp(values):
    largest = max(values)
    return largest + math.log(sum(math.exp(x - largest) for x in values))


def mean_nll(examples, beta):
    if not examples:
        return None
    return sum(beta * played + logsumexp([-beta * loss for loss in losses])
               for losses, played in examples) / len(examples)


def fit_beta(examples):
    # Bounded one-dimensional likelihood optimization, no SciPy required.
    left, right = 0.0, 20.0
    ratio = (math.sqrt(5) - 1) / 2
    a = right - ratio * (right - left)
    b = left + ratio * (right - left)
    for _ in range(90):
        if mean_nll(examples, a) <= mean_nll(examples, b):
            right, b = b, a
            a = right - ratio * (right - left)
        else:
            left, a = a, b
            b = left + ratio * (right - left)
    return (left + right) / 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--engine", type=Path, required=True, help="Official Stockfish 19 executable")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--depth", type=int, default=6)
    parser.add_argument("--per-band", type=int, default=300)
    parser.add_argument("--seed", type=int, default=202401)
    args = parser.parse_args()
    if not 1 <= args.depth <= 30 or args.per_band < 20:
        parser.error("depth must be 1–30 and per-band must be at least 20")
    reservoirs, available = sample_games(args.parquet, args.per_band, args.seed)
    print("Eligible 5+0 player-games:", dict(sorted(available.items())), flush=True)
    if any(len(reservoirs[low]) < 20 for low, _ in BANDS):
        raise RuntimeError("A rating band has fewer than 20 sampled games; use another shard")
    engine = chess.engine.SimpleEngine.popen_uci(str(args.engine))
    engine_name = engine.id.get("name", "")
    if "Stockfish 19" not in engine_name:
        engine.quit()
        raise RuntimeError("Calibration requires Stockfish 19")
    engine.configure({"Threads": 1, "Hash": 32, "UCI_LimitStrength": False})
    samples = defaultdict(lambda: {"train": [], "holdout": []})
    try:
        for low, _ in BANDS:
            games = reservoirs[low]
            random.Random(args.seed + low).shuffle(games)
            for index, item in enumerate(games):
                position = sample_position(item, args.seed)
                if position is None:
                    continue
                board, played = position
                scored = score_position(engine, board, played, args.depth)
                if scored is None:
                    continue
                player = item[3] or item[0]
                bucket = hashlib.sha256(f"{args.seed}:{player}".encode()).digest()[0]
                partition = "holdout" if bucket < 51 else "train"
                samples[low][partition].append(scored)
                if (index + 1) % 50 == 0:
                    print(f"{low}: {index + 1}/{len(games)} games evaluated", flush=True)
    finally:
        engine.quit()
    fitted = []
    for low, high in BANDS:
        train = samples[low]["train"]
        holdout = samples[low]["holdout"]
        if len(train) < 20 or len(holdout) < 5:
            raise RuntimeError(f"Insufficient scored positions for {low}–{high}")
        beta = fit_beta(train)
        row = {"minRating": low, "maxRating": high, "betaPerPawn": round(beta, 6),
               "trainPositions": len(train), "holdoutPositions": len(holdout),
               "holdoutNll": round(mean_nll(holdout, beta), 6),
               "uniformNll": round(mean_nll(holdout, 0), 6)}
        fitted.append(row)
        print(row, flush=True)
    output = {"schemaVersion": 1, "source": "Lichess/standard-chess-games",
              "parquet": args.parquet.name, "timeControl": "300+0",
              "engine": engine_name, "depth": args.depth,
              "selection": "one position per player-game, plies 8–60; held-out players by hashed username",
              "model": "P(move) proportional to exp(-betaPerPawn * min(8, centipawnLoss / 100))",
              "ratingSystem": "Lichess Glicko-2; not Chess.com Elo",
              "bands": fitted}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print("Saved", args.output, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Calibration failed: {error}", file=sys.stderr)
        raise
