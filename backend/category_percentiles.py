"""
category_percentiles.py — per-category save/velocity percentile ranks for pins.

Diagnostic + ranking signal; does not replace global save_count >= 500 crawl gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _percentile_rank(value: float, sorted_values: list[float]) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return 100.0 if value >= sorted_values[0] else 0.0
    below = sum(1 for v in sorted_values if v < value)
    equal = sum(1 for v in sorted_values if v == value)
    return round((below + 0.5 * equal) / len(sorted_values) * 100, 1)


@dataclass
class CategoryPercentileIndex:
    """category -> sorted save_count and velocity lists"""
    saves_by_cat: dict[str, list[float]]
    velocity_by_cat: dict[str, list[float]]

    @classmethod
    def from_pins(cls, pins: list[dict], *, category_key: str = "category") -> "CategoryPercentileIndex":
        saves: dict[str, list[float]] = {}
        velocity: dict[str, list[float]] = {}
        for p in pins:
            cat = (p.get(category_key) or "unknown").lower()
            sc = float(p.get("save_count") or 0)
            sv = p.get("save_velocity")
            saves.setdefault(cat, []).append(sc)
            if sv is not None:
                velocity.setdefault(cat, []).append(float(sv))
        for cat in saves:
            saves[cat].sort()
        for cat in velocity:
            velocity[cat].sort()
        return cls(saves_by_cat=saves, velocity_by_cat=velocity)

    def metrics_for_pin(self, pin: dict, *, category_key: str = "category") -> dict[str, Any]:
        cat = (pin.get(category_key) or "unknown").lower()
        sc = float(pin.get("save_count") or 0)
        sv = pin.get("save_velocity")
        save_list = self.saves_by_cat.get(cat, [])
        vel_list = self.velocity_by_cat.get(cat, [])
        save_pct = _percentile_rank(sc, save_list) if save_list else None
        vel_pct = _percentile_rank(float(sv), vel_list) if sv is not None and vel_list else None
        rank = None
        if save_list:
            # 1 = highest saves in category
            rank = len(save_list) - sum(1 for v in save_list if v > sc)
        return {
            "save_percentile_in_category": save_pct,
            "velocity_percentile_in_category": vel_pct,
            "category_rank": rank,
            "category_pin_count": len(save_list),
        }
