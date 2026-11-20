"""Load test for the REAL server (run it on or near the computer that will host the site).

    "%LOCALAPPDATA%\\KaligayahanHealthCenter\\venv\\Scripts\\python.exe" backend\\tools\\load_test.py http://localhost:8123

It only READS (pages, the public queue data, the anti-bot puzzle), so it creates no records.
It raises the number of simultaneous visitors step by step and reports, for each step, how many
requests per second the server handles and how long visitors wait. Stop the test at any time
with Ctrl+C.

Note: rate limits apply per address, so all requests from one test computer share one limit.
A few "429 Too many" answers near the end are the protection working, not a failure.
"""
from __future__ import annotations

import asyncio
import statistics
import sys
import time

import httpx


async def visitor(c: httpx.AsyncClient, base: str, rev: list, out: list, stop: float):
    while time.perf_counter() < stop:
        for path in (f"/api/public/state?rev={rev[0]}", "/", "/api/public/state?rev=-1"):
            t = time.perf_counter()
            try:
                r = await c.get(base + path)
                out.append((r.status_code, time.perf_counter() - t))
                if path.endswith("rev=-1") and r.status_code == 200:
                    rev[0] = r.json().get("rev", rev[0])
            except Exception:
                out.append((0, time.perf_counter() - t))


async def main(base: str):
    base = base.rstrip("/")
    print(f"\nLoad test of {base} (read-only)\n")
    print(f"{'visitors':>9} {'req/s':>7} {'median':>8} {'slowest 5%':>11} {'errors':>7} {'busy (429)':>11}")
    async with httpx.AsyncClient(timeout=30, limits=httpx.Limits(max_connections=400), verify=False, headers={"Accept": "application/json"}) as c:
        rev = [-1]
        for n in (5, 20, 50, 100, 200):
            out: list = []
            t0 = time.perf_counter()
            await asyncio.gather(*[visitor(c, base, rev, out, t0 + 15) for _ in range(n)])
            wall = time.perf_counter() - t0
            ok = [d for s, d in out if s == 200]
            busy = sum(1 for s, _ in out if s == 429)
            err = sum(1 for s, _ in out if s not in (200, 304, 429))
            p95 = sorted(ok)[int(len(ok) * 0.95)] if ok else 0
            print(f"{n:>9} {len(out) / wall:>7.0f} {statistics.median(ok) * 1000 if ok else 0:>6.0f}ms {p95 * 1000:>9.0f}ms {err:>7} {busy:>11}")
            if ok and statistics.median(ok) > 3:
                print("\nVisitors now wait more than 3 seconds: this is about the limit of this computer.")
                break
    print("\nA health center with 100-200 patients a day rarely has more than 20-50 people on the site at once.\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        asyncio.run(main(sys.argv[1]))
    except KeyboardInterrupt:
        pass
