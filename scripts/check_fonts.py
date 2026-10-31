# -*- coding: utf-8 -*-
"""驗證 assets/fonts/NotoSansTC.woff2 是否涵蓋原始碼裡所有會顯示的中文字。

漏一個字的後果：那個字會掉回系統字型，中英混排就會看出兩套骨架（而且只有那一個字怪，
很難發現）。所以在 commit 前跑這支檢查。

執行：C:/Users/user/AppData/Local/Programs/Python/Python313/python.exe scripts/check_fonts.py
"""
import os
import sys
from fontTools.ttLib import TTFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
from fetch_fonts import SCAN  # noqa: E402  （共用同一份掃描清單，避免兩邊不同步）

FONT = os.path.join(BASE, "assets", "fonts", "NotoSansTC.woff2")


def used():
    chars = set()
    for name in SCAN:
        with open(os.path.join(BASE, name), encoding="utf-8") as fh:
            for ch in fh.read():
                if ord(ch) > 0x2000:
                    chars.add(ch)
    return chars


def main():
    if not os.path.exists(FONT):
        print("找不到 " + FONT)
        return 1
    cmap = set()
    f = TTFont(FONT)
    for table in f["cmap"].tables:
        cmap.update(table.cmap.keys())
    want = used()
    missing = sorted(c for c in want if ord(c) not in cmap)
    total_kb = os.path.getsize(FONT) // 1024
    print(f"字型 {total_kb} KB · 需要 {len(want)} 字 · 涵蓋 {len(want) - len(missing)} 字")
    if missing:
        print("缺少（會掉回系統字型）：" + "".join(missing))
        print("請重新執行 python scripts/fetch_fonts.py")
        return 1
    print("全部涵蓋 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
