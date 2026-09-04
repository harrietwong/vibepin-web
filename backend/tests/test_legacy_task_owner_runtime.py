from __future__ import annotations

import sys
from pathlib import Path

import pytest


API_ROOT = Path(__file__).resolve().parents[2] / "api"
sys.path.insert(0, str(API_ROOT))

from app.core.row_shape import InvalidSingleRowShape, exact_single_mapping  # noqa: E402


def test_settings_row_accepts_absent_and_exact_single_mapping() -> None:
    assert exact_single_mapping(None) == {}
    row = {"user_id": "owner", "pinterest_access_token": "not-a-real-token"}
    assert exact_single_mapping(row) is row


@pytest.mark.parametrize("invalid", [[], [{}], "row", 1, True])
def test_settings_row_rejects_ambiguous_or_invalid_shapes(invalid: object) -> None:
    with pytest.raises(InvalidSingleRowShape, match="expected one mapping or no row"):
        exact_single_mapping(invalid)
