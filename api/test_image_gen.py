"""
Image generation smoke test — gpt-image-1.

Usage:
    # Text-to-image (no product photos)
    python test_image_gen.py

    # Multi-product scene (pass local image paths)
    python test_image_gen.py product1.jpg product2.jpg product3.jpg
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.services.image_gen import generate_images


async def main():
    # Load any product images passed as CLI args
    product_images: list[bytes] = []
    for path in sys.argv[1:]:
        p = Path(path)
        if p.exists():
            product_images.append(p.read_bytes())
            print(f"  loaded product image: {p.name}  ({p.stat().st_size // 1024} KB)")
        else:
            print(f"  [warn] file not found: {path}")

    mode = f"multi-product ({len(product_images)} images)" if product_images else "text-to-image"
    print(f"\nGenerating scene — mode: {mode}, style: scandinavian")
    print("This takes ~10-20 seconds...\n")

    try:
        img_2x3, img_1x1 = await generate_images(
            product_images=product_images,
            style="scandinavian",
            platform_style="pinterest",
        )

        out_2x3 = Path("test_2x3.png")
        out_1x1 = Path("test_1x1.png")
        out_2x3.write_bytes(img_2x3)
        out_1x1.write_bytes(img_1x1)

        print(f"[OK] 2:3 Pinterest -> {out_2x3}  ({len(img_2x3) // 1024} KB)")
        print(f"[OK] 1:1 Instagram -> {out_1x1}  ({len(img_1x1) // 1024} KB)")

        import subprocess
        subprocess.Popen(["cmd", "/c", "start", str(out_2x3)])
        subprocess.Popen(["cmd", "/c", "start", str(out_1x1)])

    except Exception as e:
        print(f"[ERR] {type(e).__name__}: {e}")
        raise


asyncio.run(main())
