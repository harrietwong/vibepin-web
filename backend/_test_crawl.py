import asyncio, sys, os
sys.path.insert(0, "C:/vibepinbackend")
sys.path.insert(0, "C:/vibepinbackend/db")
from dotenv import load_dotenv
load_dotenv()
os.chdir("C:/vibepinbackend")

async def test():
    from pipeline import step_crawl
    result = await step_crawl(concurrency=1, limit_keywords=2, category="digital-products")
    print("Result:", result)

asyncio.run(test())
