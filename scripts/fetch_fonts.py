# -*- coding: utf-8 -*-
"""建立本站自帶的字型檔（執行期不連 Google Fonts CDN）。

  Inter.woff2          內文 / UI        (latin subset)
  SpaceGrotesk.woff2   標題 / 顯示字     (latin subset)
  JetBrainsMono.woff2  數字 / 表格       (latin subset)
  NotoSansTC.woff2     中文 —— **subset 成這個站真正用到的字**

為什麼中文字一定要自己做子集：完整 Noto Sans TC 約 12 MB，不可能放進靜態站；
但如果直接用系統中文字（Windows 微軟正黑體 / macOS 蘋方 / Linux 文泉驛），
換一台機器版面就會走鐘（字寬、標點、粗細都不同）。
做法是把 index.html 與 js/*.js 掃過一遍，收集所有「程式碼裡出現過的非 ASCII 字元」，
再用 fontTools 把 Noto Sans TC 裁到只剩這些字 —— 連執行期才組合出來的字串
（例如「億」「萬」單位、日期格式）也一併涵蓋，因為它們都是原始碼裡的常量。

執行：
  C:/Users/user/AppData/Local/Programs/Python/Python313/python.exe scripts/fetch_fonts.py
驗證（確認沒有漏字）：
  C:/Users/user/AppData/Local/Programs/Python/Python313/python.exe scripts/check_fonts.py
"""
import hashlib
import os
import re
import subprocess
import sys
import urllib.request
from collections import OrderedDict

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FDIR = os.path.join(BASE, "assets", "fonts")
TMP = os.path.join(BASE, ".fontbuild")
os.makedirs(FDIR, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")

LATIN = [("Inter", [400, 500, 600, 700]),
         ("Space Grotesk", [500, 700]),
         ("JetBrains Mono", [400, 500, 700])]
NOTO_VF = ("https://raw.githubusercontent.com/notofonts/noto-cjk/main/"
           "Sans/Variable/TTF/Subset/NotoSansTC-VF.ttf")

LATIN_RANGE = ("U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,"
               "U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,"
               "U+2212,U+2215,U+FEFF,U+FFFD")

SCAN = ["index.html"] + ["js/" + f for f in sorted(os.listdir(os.path.join(BASE, "js"))) if f.endswith(".js")]


def get(url, timeout=180):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout).read()


def used_chars():
    """原始碼裡所有可能顯示出來的非 ASCII 字元（中文、全形標點、≥ · → 等）。"""
    chars = set("0123456789")
    for name in SCAN:
        with open(os.path.join(BASE, name), encoding="utf-8") as fh:
            for ch in fh.read():
                if ord(ch) > 0x2000:
                    chars.add(ch)
    return "".join(sorted(chars))


def latin_fonts():
    by_family = OrderedDict()
    for fam, weights in LATIN:
        q = ("https://fonts.googleapis.com/css2?family=" + fam.replace(" ", "+") +
             ":wght@" + ";".join(str(x) for x in weights) + "&display=swap")
        css = get(q, 60).decode("utf-8")
        got = 0
        for face in re.findall(r"@font-face\s*\{(.*?)\}", css, re.S):
            ur = re.search(r"unicode-range:\s*([^;}]+)", face)
            if not ur or "U+0000-00FF" not in ur.group(1):
                continue                                  # 只取 latin 區塊
            w = int(re.search(r"font-weight:\s*(\d+)", face).group(1))
            data = get(re.search(r"url\((https://[^)]+)\)", face).group(1), 60)
            key = hashlib.sha1(data).hexdigest()[:8]
            g = by_family.setdefault(fam, OrderedDict()).setdefault(key, {"data": data, "weights": []})
            g["weights"].append(w)
            got += 1
        print(f"  {fam}: {got} latin faces")

    blocks, total = [], 0
    for fam, groups in by_family.items():
        for key, g in groups.items():
            fn = f"{fam.replace(' ', '')}.woff2"
            with open(os.path.join(FDIR, fn), "wb") as fh:
                fh.write(g["data"])
            total += len(g["data"])
            ws = sorted(g["weights"])
            weight = str(ws[0]) if len(ws) == 1 else f"{ws[0]} {ws[-1]}"
            blocks.append(f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{weight};"
                          f"font-display:swap;src:url('../fonts/{fn}') format('woff2');"
                          f"unicode-range:{LATIN_RANGE}}}")
            print(f"    {fn}  {weight}  {len(g['data']) // 1024} KB")
    return blocks, total


def cjk_font():
    charset = used_chars()
    print(f"  字元集：{len(charset)} 個字")
    textfile = os.path.join(TMP, "charset.txt")
    with open(textfile, "w", encoding="utf-8") as fh:
        fh.write(charset)

    src = os.path.join(TMP, "NotoSansTC-VF.ttf")
    if not os.path.exists(src) or os.path.getsize(src) < 1_000_000:
        data = get(NOTO_VF, 600)
        if data[:4] != b"\x00\x01\x00\x00":
            raise RuntimeError("Noto Sans TC 下載內容不是 TTF：" + NOTO_VF)
        with open(src, "wb") as fh:
            fh.write(data)
    print(f"  來源：NotoSansTC-VF.ttf {os.path.getsize(src) // 1024} KB")

    out = os.path.join(FDIR, "NotoSansTC.woff2")
    subprocess.run([sys.executable, "-m", "fontTools.subset", src,
                    f"--text-file={textfile}", "--flavor=woff2",
                    "--layout-features=*", "--drop-tables+=DSIG",
                    f"--output-file={out}"], check=True)
    size = os.path.getsize(out)
    print(f"  子集 → NotoSansTC.woff2 {size // 1024} KB")
    block = ("@font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:300 900;"
             "font-display:swap;src:url('../fonts/NotoSansTC.woff2') format('woff2')}")
    return [block], size


def main():
    print("— latin 字型 —")
    latin_blocks, total = latin_fonts()
    print("— 中文字型（子集）—")
    cjk_blocks, cjk_total = cjk_font()

    header = ("/* ══════════════════════════════════════════════════════════\n"
              "   DCA LAB — self-hosted webfonts（執行期不連 CDN，離線也能正常顯示）\n"
              "   Inter / Space Grotesk / JetBrains Mono  latin subset\n"
              "   Noto Sans TC  中文，子集成本站實際用到的字（跨機器外觀一致）\n"
              "   重新產生：python scripts/fetch_fonts.py\n"
              "   ══════════════════════════════════════════════════════════ */\n")
    with open(os.path.join(BASE, "assets", "css", "fonts.css"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(header + "\n".join(latin_blocks + cjk_blocks) + "\n")
    print(f"fonts.css 已寫入 · latin {total // 1024} KB + 中文 {cjk_total // 1024} KB")


if __name__ == "__main__":
    main()
