import asyncio, sys, os
sys.path.insert(0, "C:/vibepinbackend")
sys.path.insert(0, "C:/vibepinbackend/db")
from dotenv import load_dotenv
load_dotenv()
os.chdir("C:/vibepinbackend")

async def main():
    from pipeline import step_crawl
    # digital-products
    r1 = await step_crawl(concurrency=2, limit_keywords=50, category="digital-products")
    print(f"digital-products done: {r1}")
    # holidays-seasonal
    r2 = await step_crawl(concurrency=2, limit_keywords=35, category="holidays-seasonal")
    print(f"holidays-seasonal done: {r2}")

asyncio.run(main())
