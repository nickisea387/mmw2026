#!/usr/bin/env python3
"""Check Eventbrite for sold-out / availability signals and write ticket_signals.json.

Uses only stdlib (urllib). Searches Eventbrite's public event pages for each event
and looks for sold-out / sales-ended indicators in the HTML response.
"""
import json
import time
import urllib.request
import urllib.parse
import re
from datetime import datetime, timezone

# Allow running from repo root or scripts/
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from config import (
    TICKET_SIGNALS_FILE, parse_events, save_json,
)

# Indicators that an event is sold out or tickets are ending
SOLD_OUT_PATTERNS = [
    re.compile(r'sold\s*out', re.IGNORECASE),
    re.compile(r'sales?\s*ended', re.IGNORECASE),
    re.compile(r'registration\s*closed', re.IGNORECASE),
]

FINAL_RELEASE_PATTERNS = [
    re.compile(r'final\s*release', re.IGNORECASE),
    re.compile(r'last\s*chance', re.IGNORECASE),
    re.compile(r'almost\s*gone', re.IGNORECASE),
    re.compile(r'limited\s*availability', re.IGNORECASE),
    re.compile(r'few\s*remaining', re.IGNORECASE),
]

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)


def check_eventbrite(event_name):
    """Search Eventbrite for the event and check availability status.

    Returns dict with 'soldOut' (bool) and 'status' (str).
    """
    # Build search URL
    slug = urllib.parse.quote(event_name)
    url = f"https://www.eventbrite.com/d/fl--miami/{slug}/"

    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
    })

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            # Read up to 500KB to avoid downloading huge pages
            html = resp.read(512_000).decode('utf-8', errors='replace')
    except Exception as e:
        print(f"    Eventbrite fetch failed: {e}")
        return {'soldOut': False, 'status': 'unknown'}

    # Check for sold-out indicators
    for pattern in SOLD_OUT_PATTERNS:
        if pattern.search(html):
            return {'soldOut': True, 'status': 'sold_out'}

    # Check for limited-availability indicators
    for pattern in FINAL_RELEASE_PATTERNS:
        if pattern.search(html):
            return {'soldOut': False, 'status': 'final_release'}

    return {'soldOut': False, 'status': 'available'}


def main():
    print("=" * 60)
    print("Ticket Availability Scraper (Eventbrite)")
    print("=" * 60)

    events = parse_events()
    if not events:
        print("No events found. Exiting.")
        return

    signals = {}

    for ev in events:
        eid = ev['id']
        name = ev['name']

        print(f"  [{eid}] {name}...")

        result = check_eventbrite(name)
        signals[str(eid)] = result

        status_str = result['status']
        if result['soldOut']:
            status_str = "SOLD OUT"
        print(f"    -> {status_str}")

        # Be polite — don't hammer Eventbrite
        time.sleep(1.5)

    output = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'signals': signals,
    }
    save_json(TICKET_SIGNALS_FILE, output)

    sold_count = sum(1 for s in signals.values() if s['soldOut'])
    final_count = sum(1 for s in signals.values() if s['status'] == 'final_release')
    print(f"\nDone. {sold_count} sold out, {final_count} final release, "
          f"{len(signals) - sold_count - final_count} available.")


if __name__ == '__main__':
    main()
