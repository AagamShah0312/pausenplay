import asyncio
import os
import subprocess
from playwright.async_api import async_playwright

async def run_verification():
    print("Starting Playwright verification...")
    os.makedirs("verification_out", exist_ok=True)

    # Start local server in the background
    # Kill anything on port 8000 first to be safe
    subprocess.run("kill $(lsof -t -i:8000) 2>/dev/null || true", shell=True)
    server_process = subprocess.Popen(
        ["python3", "-m", "http.server", "8000"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    await asyncio.sleep(1.5) # Give it time to start

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=["--no-sandbox", "--disable-setuid-sandbox"])
            page = await browser.new_page(viewport={"width": 1280, "height": 800})

            # Catch console logs and page errors
            page.on("console", lambda msg: print(f"CONSOLE: [{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

            print("Navigating to http://localhost:8000...")
            await page.goto("http://localhost:8000")
            await page.wait_for_timeout(1000)

            # Check for intro presence and skip button click
            skip_btn = await page.query_selector("#skip-btn")
            if skip_btn:
                print("Skip button found. Clicking it...")
                await skip_btn.click()
                await page.wait_for_timeout(1500) # Wait for fadeout transition

            # Check if main site is visible now
            main_site = await page.query_selector("#main-site")
            if main_site:
                opacity = await main_site.evaluate("el => getComputedStyle(el).opacity")
                print(f"Main site opacity: {opacity}")

            # Capture hero section screenshot
            print("Capturing hero screenshot...")
            await page.screenshot(path="verification_out/verification.png")

            # Scroll down to About and Games section to trigger Three.js rendering & scroll tilts
            print("Scrolling down to About section...")
            await page.evaluate("window.scrollTo(0, 1000)")
            await page.wait_for_timeout(1000)
            await page.screenshot(path="verification_out/verification_about.png")

            print("Scrolling down further to Games section...")
            await page.evaluate("window.scrollTo(0, 2000)")
            await page.wait_for_timeout(1000)
            await page.screenshot(path="verification_out/verification_games.png")

            await browser.close()
            print("Playwright verification finished successfully!")
    finally:
        # Clean up background server
        server_process.kill()

if __name__ == "__main__":
    asyncio.run(run_verification())
