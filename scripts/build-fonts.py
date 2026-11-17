# 나눔스퀘어라운드 웹글꼴 만들기: 굵기마다 3조각 (core=앱 화면 글자, ks=자주 쓰는 한글 2350자, full=나머지 전부)
# 쓰는 법: python3 scripts/build-fonts.py <ttf폴더> index.html,engine.js fonts
#   ttf는 npm 패키지 @kfonts/nanum-square-round 의 src/ (NAVER 원본 NanumSquareRoundR/B.ttf). pip install fonttools brotli 필요.
#   화면 글자를 많이 바꾼 뒤 다시 돌리면 core 조각이 새 글자를 담는다 (안 돌려도 ks·full 조각이 대신 그려서 깨지지는 않음).
import sys,os
from fontTools import subset
from fontTools.ttLib import TTFont
src,app_files,out=sys.argv[1],sys.argv[2].split(','),sys.argv[3]
txt=''.join(open(f,encoding='utf8').read() for f in app_files)
cmap=set(TTFont(os.path.join(src,'NanumSquareRoundR.ttf')).getBestCmap())
core=sorted((set(ord(c) for c in txt)|set(range(0x20,0x7f))|{0xa0})&cmap)
ks=sorted(c for c in range(0xAC00,0xD7A4) if len(chr(c).encode('euc-kr','ignore'))==2)
def rng(cs):
  r=[];s=p=cs[0]
  for c in cs[1:]:
    if c==p+1: p=c; continue
    r.append((s,p)); s=p=c
  r.append((s,p))
  return ','.join(f'U+{a:X}' if a==b else f'U+{a:X}-{b:X}' for a,b in r)
# 같은 글자를 여러 조각이 가지면 나중에 적은 @font-face가 먼저 쓰인다 → full, ks, core 순으로 적는다
# full에도 글꼴에 실제로 있는 글자 범위를 적어야, 글꼴에 없는 기호(✓ ▸ 등)를 그릴 때 full 조각을 괜히 받지 않는다
css=['/* 나눔스퀘어라운드 (NAVER, SIL OFL 1.1, fonts/OFL.txt). scripts/build-fonts.py가 만든 파일 */']
for w,fn in ((400,'R'),(700,'B')):
  for name,cs,ur in (('full',None,rng(sorted(cmap))),('ks',ks,'U+AC00-D7A3'),('core',core,rng(core))):
    o=subset.Options(); o.flavor='woff2'; o.hinting=False; o.desubroutinize=True; o.name_IDs=['*']; o.name_languages=['*']; o.notdef_outline=True
    f=TTFont(os.path.join(src,f'NanumSquareRound{fn}.ttf'))
    s=subset.Subsetter(o); s.populate(unicodes=cs if cs else sorted(cmap)); s.subset(f)
    p=f'nsr-{fn.lower()}-{name}.woff2'; f.flavor='woff2'; f.save(os.path.join(out,p))
    print(p, os.path.getsize(os.path.join(out,p)))
    css.append(f'@font-face{{font-family:"NanumSquareRound";font-weight:{w};font-display:swap;src:url({p}) format("woff2")'+(f';unicode-range:{ur}' if ur else '')+'}')
open(os.path.join(out,'fonts.css'),'w').write('\n'.join(css)+'\n')
