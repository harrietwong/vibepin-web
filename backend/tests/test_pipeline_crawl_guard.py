"""Unit tests for crawl-step replenish guard."""

import unittest
from unittest.mock import AsyncMock, patch

import pipeline


class TestPipelineCrawlGuard(unittest.IsolatedAsyncioTestCase):
    async def test_crawl_runs_trends_when_pending_low(self):
        with patch.object(pipeline, "replenish_crawl_queue_if_needed", new_callable=AsyncMock) as replenish:
            replenish.return_value = 25
            with patch.object(pipeline, "_db_select", return_value=[]):
                result = await pipeline.step_crawl(replenish=True, limit_keywords=10)
            replenish.assert_awaited_once()
            self.assertEqual(result["processed"], 0)

    async def test_crawl_exits_cleanly_when_still_empty_after_replenish(self):
        with patch.object(pipeline, "replenish_crawl_queue_if_needed", new_callable=AsyncMock) as replenish:
            replenish.return_value = 0
            result = await pipeline.step_crawl(replenish=True)
            self.assertTrue(result.get("skipped"))
            self.assertEqual(result["processed"], 0)

    async def test_replenish_skipped_when_pending_high(self):
        with patch("crawl_queue_ops.count_pending_items", return_value=50):
            pending = await pipeline.replenish_crawl_queue_if_needed(min_pending=20)
            self.assertEqual(pending, 50)


if __name__ == "__main__":
    unittest.main()
