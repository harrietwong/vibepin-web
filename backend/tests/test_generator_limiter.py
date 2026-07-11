import asyncio
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import generator  # noqa: E402


class ProviderPermitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_root = generator.GENERATION_LOCK_ROOT
        self.old_limit = generator.PROVIDER_CONCURRENCY_LIMIT
        self.old_wait = generator.PROVIDER_PERMIT_WAIT_TIMEOUT_SECONDS
        self.old_ttl = generator.PROVIDER_PERMIT_TTL_SECONDS
        generator.GENERATION_LOCK_ROOT = Path(self.tmp.name)
        generator.PROVIDER_CONCURRENCY_LIMIT = 1
        generator.PROVIDER_PERMIT_WAIT_TIMEOUT_SECONDS = 0
        generator.PROVIDER_PERMIT_TTL_SECONDS = 60

    async def asyncTearDown(self):
        generator.GENERATION_LOCK_ROOT = self.old_root
        generator.PROVIDER_CONCURRENCY_LIMIT = self.old_limit
        generator.PROVIDER_PERMIT_WAIT_TIMEOUT_SECONDS = self.old_wait
        generator.PROVIDER_PERMIT_TTL_SECONDS = self.old_ttl
        self.tmp.cleanup()

    async def test_provider_permit_releases_directory(self):
        async with generator.ProviderPermit(
            generation_request_id="test-request",
            output_index=0,
            variant_role="anchor",
            provider_model="gpt-image-2",
        ) as permit:
            self.assertIsNotNone(permit.permit_dir)
            self.assertTrue(permit.permit_dir.exists())

        self.assertFalse((Path(self.tmp.name) / "provider-linapi" / "permit-0").exists())

    async def test_provider_permit_busy_when_limit_full(self):
        async with generator.ProviderPermit(
            generation_request_id="holder",
            output_index=0,
            variant_role="anchor",
            provider_model="gpt-image-2",
        ):
            with self.assertRaisesRegex(ValueError, generator.ERR_PROVIDER_BUSY):
                await generator.ProviderPermit(
                    generation_request_id="blocked",
                    output_index=1,
                    variant_role="variant",
                    provider_model="gpt-image-2",
                ).__aenter__()

    async def test_provider_permit_reclaims_expired_lock(self):
        permit_dir = Path(self.tmp.name) / "provider-linapi" / "permit-0"
        permit_dir.mkdir(parents=True)
        (permit_dir / "owner.json").write_text(
            '{"generationRequestId":"stale","expiresAt":1}',
            encoding="utf-8",
        )

        async with generator.ProviderPermit(
            generation_request_id="fresh",
            output_index=0,
            variant_role="anchor",
            provider_model="gpt-image-2",
        ) as permit:
            self.assertEqual(permit.permit_dir, permit_dir)
            owner = (permit_dir / "owner.json").read_text(encoding="utf-8")
            self.assertIn('"generationRequestId": "fresh"', owner)


if __name__ == "__main__":
    unittest.main()
