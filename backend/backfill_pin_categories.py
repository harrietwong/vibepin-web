"""Rename legacy pin_samples.category values to match current DB category IDs."""
import sys; sys.path.insert(0, 'db')
from db import _get_http

http = _get_http()

REMAP = {
    "home":          "home-decor",
    "sport":         "sports",
    "diy":           "diy-crafts",
    "food":          "food-and-drink",
    "health_wellness": "health",
}

for old, new in REMAP.items():
    # Count first
    count_r = http.get("pin_samples", params={"select": "id", "category": f"eq.{old}", "limit": "1000"})
    rows = count_r.json() if count_r.status_code == 200 else []
    if not rows:
        print(f"  {old}: 0 rows — skip")
        continue

    # PATCH all rows with this category
    patch_r = http.patch(
        "pin_samples",
        params={"category": f"eq.{old}"},
        json={"category": new},
    )
    if patch_r.status_code in (200, 204):
        print(f"  {old} -> {new}: {len(rows)} pins updated OK")
    else:
        print(f"  {old} -> {new}: ERROR {patch_r.status_code} {patch_r.text[:200]}")

print("\nDone.")
