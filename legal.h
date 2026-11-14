#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// Each move occupies six bytes (five UCI characters plus a terminator).
int ChessLegalMoves(const char *fen, char *moves, int capacity);
bool ChessFenLegal(const char *fen);

#ifdef __cplusplus
}
#endif
