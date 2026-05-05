"""
Click-to-pick template helper.

Usage:
  uv run --with opencv-python --with numpy local_tests/pick_template.py \
      <input.png> [<output_template.png>] [<half_size_px>]

Opens the input image in an OpenCV window. Click the recipe-book button (or
any UI element you want a template for). The script crops a square patch
centered on the click and writes it to the output path. Press 'q' or ESC to
finish; clicks accumulate (last click wins) so you can re-click if you missed.

Defaults:
  output_template.png = local_tests/fixtures/recipe_book_template.png
  half_size_px        = 9  (so 18x18 crop)

After saving, prints the click pixel + crop bbox so we can wire the
detector to the same coords.
"""
import os
import sys
import cv2
import numpy as np

src = sys.argv[1] if len(sys.argv) > 1 else None
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "ui-templates",
    "recipe_book.png",
)
half = int(sys.argv[3]) if len(sys.argv) > 3 else 9
if not src:
    print("usage: pick_template.py <input.png> [<out_template.png>] [<half_size_px>]")
    sys.exit(1)

img = cv2.imread(src)
if img is None:
    print(f"failed to read {src}")
    sys.exit(2)
h, w = img.shape[:2]
print(f"loaded {src}  {w}x{h}  click recipe-book button center; q/ESC to save & exit")

last_click = [None]
view = img.copy()

def on_click(event, x, y, flags, param):
    if event == cv2.EVENT_LBUTTONDOWN:
        last_click[0] = (x, y)
        print(f"clicked: ({x}, {y})")
        view[:] = img.copy()
        cv2.rectangle(view, (x - half, y - half), (x + half, y + half), (255, 0, 255), 1)
        cv2.circle(view, (x, y), 1, (255, 0, 255), -1)
        cv2.imshow("frame", view)

cv2.namedWindow("frame", cv2.WINDOW_NORMAL | cv2.WINDOW_KEEPRATIO)
cv2.resizeWindow("frame", w * 3, h * 3)
cv2.imshow("frame", view)
cv2.setMouseCallback("frame", on_click)
while True:
    k = cv2.waitKey(50)
    if k in (ord('q'), 27):
        break
    if cv2.getWindowProperty("frame", cv2.WND_PROP_VISIBLE) < 1:
        break
cv2.destroyAllWindows()

if last_click[0] is None:
    print("no click recorded — exiting without writing template")
    sys.exit(3)

cx, cy = last_click[0]
x0 = max(0, cx - half); y0 = max(0, cy - half)
x1 = min(w, cx + half); y1 = min(h, cy + half)
crop = img[y0:y1, x0:x1]
os.makedirs(os.path.dirname(out), exist_ok=True)
cv2.imwrite(out, crop)
print(f"saved {out}  click=({cx},{cy})  crop bbox=({x0},{y0})..({x1},{y1})  size={crop.shape}")
