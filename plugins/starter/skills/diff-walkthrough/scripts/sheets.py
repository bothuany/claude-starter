#!/usr/bin/env python3
"""Tile <deck>.stills/scene-NN.png into 2x2 contact sheets (<deck>.stills/sheets/sheet-NN.png) so a
reviewer can read four scenes per image. Each tile is labelled with its scene number."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

st = Path(sys.argv[1])
out = st / "sheets"
out.mkdir(exist_ok=True)
for f in out.glob("*.png"):
    f.unlink()
files = sorted(st.glob("scene-*.png"))
for i in range(0, len(files), 4):
    sheet = Image.new("RGB", (1920, 1080), "black")
    d = ImageDraw.Draw(sheet)
    for k, f in enumerate(files[i:i + 4]):
        x, y = (k % 2) * 960, (k // 2) * 540
        sheet.paste(Image.open(f).convert("RGB").resize((960, 540), Image.LANCZOS), (x, y))
        d.rectangle([x, y, x + 44, y + 22], fill="black")
        d.text((x + 6, y + 5), f.stem.split("-")[-1], fill="yellow")
    sheet.save(out / f"sheet-{i // 4:02d}.png")
print(f"{len(files)} stills -> {len(list(out.glob('*.png')))} sheets in {out}")
