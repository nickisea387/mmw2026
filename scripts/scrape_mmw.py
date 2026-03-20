#!/usr/bin/env python3
"""Scrape the official miamimusicweek.com events page for new events.

Checks the official MMW site and writes any events not already in data.js
to data/mmw_new_events.json for manual review and addition.
"""
import json
import time
import re
import urllib.request
from datetime import datetime, timezone

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from config import parse_events, save_json, DATA_DIR

OUTPUT_FILE = os.path.join(DATA_DIR, 'mmw_new_events.json')
USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'


def fetch_page(url):
    """Fetch a URL and return the HTML content."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f"  Error fetching {url}: {e}")
        return ''


def extract_event_links(html):
    """Extract event page URLs from the MMW events listing."""
    # Look for links to individual event pages
    links = re.findall(r'href="(https?://miamimusicweek\.com/event/[^"]+)"', html)
    if not links:
        links = re.findall(r'href="(/event/[^"]+)"', html)
        links = [f"https://miamimusicweek.com{l}" for l in links]
    return list(set(links))


def extract_event_data(html, url):
    """Try to extract event details from an individual event page."""
    event = {'url': url}

    # Title
    m = re.search(r'<h1[^>]*>([^<]+)</h1>', html)
    if m: event['name'] = m.group(1).strip()

    m = re.search(r'<title>([^<]+)</title>', html)
    if not event.get('name') and m:
        event['name'] = m.group(1).split('|')[0].strip()

    # Date
    m = re.search(r'(March|Mar)\s+(\d{1,2})', html)
    if m: event['date'] = f"Mar {m.group(2)}"

    # Venue
    m = re.search(r'(?:venue|location)["\s:]+([^<"]+)', html, re.I)
    if m: event['venue'] = m.group(1).strip()

    # Artists from meta or body
    m = re.search(r'(?:lineup|artists?|featuring)["\s:]+([^<"]{10,200})', html, re.I)
    if m: event['artists'] = m.group(1).strip()

    return event


def main():
    print("=" * 60)
    print("Official MMW Site Scraper")
    print("=" * 60)

    # Get existing events for dedup
    existing = parse_events()
    existing_names = set(e['name'].lower() for e in existing)
    existing_artists = set()
    for e in existing:
        for a in e.get('artists', '').split(','):
            clean = a.strip().lower()
            if clean and clean != 'tba':
                existing_artists.add(clean)

    print(f"  Existing events: {len(existing)}")

    # Fetch main events listing
    print("  Fetching miamimusicweek.com/events...")
    html = fetch_page('https://miamimusicweek.com/events')
    if not html:
        print("  Could not fetch events page.")
        return

    links = extract_event_links(html)
    print(f"  Found {len(links)} event links")

    # Also try the events page variants
    for path in ['/events?page=2', '/events?page=3']:
        time.sleep(1)
        extra_html = fetch_page(f'https://miamimusicweek.com{path}')
        if extra_html:
            links.extend(extract_event_links(extra_html))
    links = list(set(links))
    print(f"  Total unique links: {len(links)}")

    # Check each event page
    new_events = []
    for i, url in enumerate(links[:50]):  # Cap at 50 to avoid rate limits
        time.sleep(1.5)
        event_html = fetch_page(url)
        if not event_html:
            continue

        event = extract_event_data(event_html, url)
        name = event.get('name', '')

        # Check if this is genuinely new
        if name and name.lower() not in existing_names:
            new_events.append(event)
            print(f"  NEW: {name}")
        elif name:
            pass  # Already have it

        if (i + 1) % 10 == 0:
            print(f"  Checked {i+1}/{len(links)} links...")

    # Save results
    output = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'source': 'miamimusicweek.com',
        'new_events_count': len(new_events),
        'new_events': new_events,
    }
    save_json(OUTPUT_FILE, output)
    print(f"\n  Found {len(new_events)} new events not in data.js")
    for e in new_events[:10]:
        print(f"    - {e.get('name', 'Unknown')}")


if __name__ == '__main__':
    main()
