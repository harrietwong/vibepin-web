import unittest
from unittest.mock import patch

from backend import generator


class GeneratorPrivateMediaTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_one_accepts_authenticated_owner_identity(self):
        result = await generator._generate_one(
            keyword="lamp",
            style="editorial",
            idx=0,
            generation_request_id="req-1",
            generation_owner_id="00000000-0000-4000-8000-000000000001",
            provider_mode="mock",
            mock_provider_delay_ms=0,
        )
        self.assertTrue(result.startswith("https://mock.vibepin.local/studio/"))

    def test_private_and_metadata_urls_are_rejected_before_dns(self):
        with patch.object(generator.socket, "getaddrinfo") as dns:
            self.assertIsNone(generator._resolve_public_image_url("http://127.0.0.1/x"))
            self.assertIsNone(generator._resolve_public_image_url("http://169.254.169.254/latest"))
            self.assertIsNone(generator._resolve_public_image_url("http://localhost/x"))
            dns.assert_not_called()

    def test_cgnat_literal_is_rejected_before_dns(self):
        with patch.object(generator.socket, "getaddrinfo") as dns:
            self.assertIsNone(generator._resolve_public_image_url("http://100.64.0.1/x"))
            dns.assert_not_called()

    async def test_cgnat_dns_answer_is_rejected_before_fetch(self):
        with patch.object(generator.socket, "getaddrinfo", return_value=[
            (2, 1, 6, "", ("100.64.0.1", 80)),
        ]) as dns, patch.object(generator, "_pinned_http_fetch") as fetch:
            self.assertIsNone(await generator._safe_remote_image_bytes("http://example.test/x", {}))
            dns.assert_called_once()
            fetch.assert_not_called()

    async def test_exact_supabase_private_urls_never_use_generic_fetch(self):
        urls = [
            "https://storage.test/storage/v1/object/generated-private/studio/a.png?token=x",
            "https://STORAGE.TEST:443/storage/v1/object/generated-private/studio/a.png?token=x#ignored",
            "http://storage.test/storage/v1/object/generated-private/studio/a.png?token=x#ignored",
            "https://storage.test/storage/v1/object/sign/generated-private/studio/a.png?token=x",
            "https://storage.test/storage/v1/render/image/public/generated-private/studio/a.png?width=200",
        ]
        with patch.object(generator, "SUPABASE_URL", "https://storage.test"), \
             patch.object(generator, "_private_storage_to_part", return_value=None) as private, \
             patch.object(generator, "_url_to_part") as generic:
            for url in urls:
                self.assertIsNone(await generator._image_input_to_part(url, trusted_owner_id="owner"))
            self.assertEqual(private.call_count, len(urls))
            generic.assert_not_called()

    def test_public_resolution_is_pinned_to_checked_ip(self):
        with patch.object(generator.socket, "getaddrinfo", return_value=[
            (2, 1, 6, "", ("93.184.216.34", 80)),
        ]) as dns:
            self.assertEqual(
                generator._resolve_public_image_url("http://example.test/a"),
                ("93.184.216.34", "example.test"),
            )
            self.assertEqual(dns.call_count, 1)

    async def test_private_path_requires_owner_and_provenance(self):
        src = "/api/storage-image?path=studio/x.png"
        with patch.object(generator, "SUPABASE_URL", "https://db.test"), patch.object(generator, "SUPABASE_SVC_KEY", "k"):
            self.assertIsNone(await generator._private_storage_to_part(src, ""))

    def test_anonymous_upload_writes_zero_objects(self):
        with patch.object(generator.httpx, "Client") as client:
            with self.assertRaises(ValueError):
                generator._upload_to_supabase(b"png", "studio/x.png", "")
            client.assert_not_called()

    async def test_public_redirect_to_private_is_rejected_before_second_socket(self):
        with patch.object(generator, "_resolve_public_image_url", side_effect=[("93.184.216.34", "public.test"), None]) as resolve, \
             patch.object(generator, "_pinned_http_fetch", return_value=(302, "http://127.0.0.1/private", "", b"")) as fetch:
            self.assertIsNone(await generator._safe_remote_image_bytes("https://public.test/image", {}))
            self.assertEqual(resolve.call_count, 2)
            self.assertEqual(fetch.call_count, 1)

    def test_pinned_fetch_rejects_declared_and_streamed_oversize(self):
        class Response:
            status = 200
            def __init__(self, length, chunks):
                self.length = length
                self.chunks = list(chunks)
                self.read_calls = 0
            def getheader(self, name, default=None):
                return {"Content-Length": self.length, "Content-Type": "image/png"}.get(name, default)
            def read(self, _size):
                self.read_calls += 1
                return self.chunks.pop(0) if self.chunks else b""

        class Connection:
            def __init__(self, response): self.response = response
            def request(self, *_args, **_kwargs): pass
            def getresponse(self): return self.response
            def close(self): pass

        declared = Response(str(generator._MAX_REMOTE_IMAGE_BYTES + 1), [])
        result = generator._pinned_http_fetch(
            "https://public.test/image", "93.184.216.34", {},
            connection_factory=lambda *_args: Connection(declared),
        )
        self.assertIsNone(result[3])
        self.assertEqual(declared.read_calls, 0)

        streamed = Response(None, [b"x" * (generator._MAX_REMOTE_IMAGE_BYTES + 1)])
        result = generator._pinned_http_fetch(
            "https://public.test/image", "93.184.216.34", {},
            connection_factory=lambda *_args: Connection(streamed),
        )
        self.assertIsNone(result[3])


if __name__ == "__main__":
    unittest.main()
