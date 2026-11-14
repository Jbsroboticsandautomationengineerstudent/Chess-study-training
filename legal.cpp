#include "legal.h"
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

namespace {
struct Position {
    char b[64] = {};
    int side = 0, castle = 0, ep = -1;
};
struct Move { int from, to; char promo = 0; bool ep = false, castle = false; };
int color(char p) { return p == 0 ? -1 : (std::isupper((unsigned char)p) ? 0 : 1); }
bool inside(int f, int r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
bool attacked(const Position &p, int sq, int by) {
    int f = sq % 8, r = sq / 8;
    int pr = r + (by == 0 ? -1 : 1);
    for (int df : {-1, 1}) if (inside(f + df, pr) && p.b[pr * 8 + f + df] == (by ? 'p' : 'P')) return true;
    const int nf[] = {1,2,2,1,-1,-2,-2,-1}, nr[] = {2,1,-1,-2,-2,-1,1,2};
    for (int i = 0; i < 8; ++i) if (inside(f+nf[i],r+nr[i]) && p.b[(r+nr[i])*8+f+nf[i]] == (by ? 'n' : 'N')) return true;
    for (int df = -1; df <= 1; ++df) for (int dr = -1; dr <= 1; ++dr)
        if ((df || dr) && inside(f+df,r+dr) && p.b[(r+dr)*8+f+df] == (by ? 'k' : 'K')) return true;
    for (int df = -1; df <= 1; ++df) for (int dr = -1; dr <= 1; ++dr) {
        if (!(df || dr)) continue;
        int x=f+df,y=r+dr;
        while (inside(x,y)) {
            char q=p.b[y*8+x];
            if (q) {
                if (color(q)==by) {
                    char t=(char)std::tolower((unsigned char)q);
                    if (t=='q' || (df && dr ? t=='b' : t=='r')) return true;
                }
                break;
            }
            x+=df; y+=dr;
        }
    }
    return false;
}
int king(const Position &p, int side) {
    for (int i=0;i<64;++i) if (p.b[i]==(side ? 'k':'K')) return i;
    return -1;
}
bool parse(const char *fen, Position &p) {
    if (!fen) return false;
    std::istringstream in(fen);
    std::string board, side, castle, ep, extra;
    int half, full;
    if (!(in >> board >> side >> castle >> ep >> half >> full) || (in >> extra)) return false;
    if (side!="w" && side!="b") return false;
    if (half<0 || full<1) return false;
    p.side=side=="b";
    int rank=7,file=0, wk=0,bk=0;
    for (char c:board) {
        if (c=='/') { if (file!=8 || --rank<0) return false; file=0; }
        else if (c>='1' && c<='8') { file+=c-'0'; if (file>8) return false; }
        else {
            if (!std::strchr("PNBRQKpnbrqk",c) || file>=8 || rank<0) return false;
            if (c=='K') ++wk; if (c=='k') ++bk;
            if ((c=='P' && rank==7) || (c=='p' && rank==0) || (std::tolower((unsigned char)c)=='p' && (rank==0 || rank==7))) return false;
            p.b[rank*8+file++]=c;
        }
    }
    if (rank!=0 || file!=8 || wk!=1 || bk!=1) return false;
    if (castle!="-") {
        for (char c:castle) {
            int bit=c=='K'?1:c=='Q'?2:c=='k'?4:c=='q'?8:0;
            if (!bit || (p.castle&bit)) return false;
            p.castle|=bit;
        }
    }
    if ((p.castle&1) && (p.b[4]!='K'||p.b[7]!='R')) return false;
    if ((p.castle&2) && (p.b[4]!='K'||p.b[0]!='R')) return false;
    if ((p.castle&4) && (p.b[60]!='k'||p.b[63]!='r')) return false;
    if ((p.castle&8) && (p.b[60]!='k'||p.b[56]!='r')) return false;
    if (ep!="-") {
        if (ep.size()!=2 || ep[0]<'a'||ep[0]>'h'||ep[1]!=(p.side?'3':'6')) return false;
        p.ep=(ep[1]-'1')*8+ep[0]-'a';
        if (p.b[p.ep] || p.b[p.ep+(p.side?8:-8)]!=(p.side?'P':'p')) return false;
    }
    int w=king(p,0),b=king(p,1);
    if (abs(w%8-b%8)<=1 && abs(w/8-b/8)<=1) return false;
    // The player who just moved cannot leave their king in check.
    return !attacked(p,king(p,1-p.side),p.side);
}
void add(std::vector<Move> &v,int a,int b,char promo=0,bool ep=false,bool castle=false) {
    v.push_back({a,b,promo,ep,castle});
}
void generate(const Position &p,std::vector<Move> &v) {
    int s=p.side;
    for (int a=0;a<64;++a) {
        char q=p.b[a]; if (color(q)!=s) continue;
        int f=a%8,r=a/8; char t=(char)std::tolower((unsigned char)q);
        if (t=='p') {
            int step=s?-1:1, next=r+step, last=s?0:7;
            auto pawn=[&](int b,bool e=false) { if (next==last) for (char c:std::string("qrbn")) add(v,a,b,c,e); else add(v,a,b,0,e); };
            if (inside(f,next) && !p.b[next*8+f]) {
                pawn(next*8+f);
                int two=r+2*step;
                if (r==(s?6:1) && !p.b[two*8+f]) add(v,a,two*8+f);
            }
            for (int df:{-1,1}) if (inside(f+df,next)) {
                int b=next*8+f+df;
                if (color(p.b[b])==1-s && std::tolower((unsigned char)p.b[b])!='k') pawn(b);
                if (b==p.ep && p.b[b-step*8]==(s?'P':'p')) pawn(b,true);
            }
        } else if (t=='n' || t=='k') {
            const int kf[]={1,2,2,1,-1,-2,-2,-1},kr[]={2,1,-1,-2,-2,-1,1,2};
            for (int i=0;i<(t=='n'?8:0);++i) {
                int x=f+kf[i],y=r+kr[i];
                if (inside(x,y) && color(p.b[y*8+x])!=s && std::tolower((unsigned char)p.b[y*8+x])!='k') add(v,a,y*8+x);
            }
            if (t=='k') {
                for (int df=-1;df<=1;++df) for (int dr=-1;dr<=1;++dr) if (df||dr) {
                    int x=f+df,y=r+dr;
                    if (inside(x,y) && color(p.b[y*8+x])!=s && std::tolower((unsigned char)p.b[y*8+x])!='k') add(v,a,y*8+x);
                }
                int base=s?56:0;
                if (a==base+4 && !attacked(p,a,1-s)) {
                    if ((p.castle&(s?4:1)) && !p.b[base+5] && !p.b[base+6] && !attacked(p,base+5,1-s) && !attacked(p,base+6,1-s)) add(v,a,base+6,0,false,true);
                    if ((p.castle&(s?8:2)) && !p.b[base+1] && !p.b[base+2] && !p.b[base+3] && !attacked(p,base+3,1-s) && !attacked(p,base+2,1-s)) add(v,a,base+2,0,false,true);
                }
            }
        } else {
            for (int df=-1;df<=1;++df) for (int dr=-1;dr<=1;++dr) {
                if (!(df||dr) || (t=='b' && !(df&&dr)) || (t=='r' && df&&dr)) continue;
                int x=f+df,y=r+dr;
                while (inside(x,y)) {
                    int b=y*8+x;
                    if (color(p.b[b])==s || std::tolower((unsigned char)p.b[b])=='k') break;
                    add(v,a,b);
                    if (p.b[b]) break;
                    x+=df;y+=dr;
                }
            }
        }
    }
}
bool legal(const Position &p,const Move &m) {
    Position n=p;
    n.b[m.to]=m.promo ? (char)(p.side?m.promo:std::toupper((unsigned char)m.promo)) : n.b[m.from];
    n.b[m.from]=0;
    if (m.ep) n.b[m.to+(p.side?8:-8)]=0;
    if (m.castle) {
        int base=p.side?56:0;
        if (m.to==base+6) { n.b[base+5]=n.b[base+7];n.b[base+7]=0; }
        else { n.b[base+3]=n.b[base];n.b[base]=0; }
    }
    return !attacked(n,king(n,p.side),1-p.side);
}
}
extern "C" bool ChessFenLegal(const char *fen) { Position p; return parse(fen,p); }
extern "C" int ChessLegalMoves(const char *fen,char *moves,int capacity) {
    Position p; if (!parse(fen,p) || !moves || capacity<=0) return 0;
    std::vector<Move> pseudo; generate(p,pseudo);
    int n=0;
    for (const Move &m:pseudo) {
        if (!legal(p,m)) continue;
        if (n==capacity) break;
        char *out=moves+n++*6;
        out[0]='a'+m.from%8;out[1]='1'+m.from/8;
        out[2]='a'+m.to%8;out[3]='1'+m.to/8;
        out[4]=m.promo;out[5]=0;
    }
    return n;
}
