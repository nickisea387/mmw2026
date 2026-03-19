#!/usr/bin/env python3
"""Scrape DICE MMW bundle page for event data and write dice_events.json.

Uses only stdlib (urllib, json, re, html.parser). Fetches the DICE Miami Music
Week bundle page, extracts event details, and compares against existing events
in data.js to flag which DICE events are NEW.
"""
import json
import time
import re
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from html.parser import HTMLParser

# Allow running from repo root or scripts/
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from config import parse_events, save_json, DATA_DIR

DICE_BUNDLE_URL = 'https://dice.fm/bundles/miami-music-week-events-55yy'
DICE_EVENTS_FILE = os.path.join(DATA_DIR, 'dice_events.json')

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)

# Rate limiting: seconds between requests
REQUEST_DELAY = 2.0


def fetch_page(url, retries=2):
    """Fetch a URL and return the HTML content as a string."""
    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    })

    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read(1_048_576).decode('utf-8', errors='replace')
        except Exception as e:
            print(f"  Fetch failed (attempt {attempt + 1}): {e}")
            if attempt < retries:
                time.sleep(REQUEST_DELAY * (attempt + 1))
            else:
                raise
    return ''


def extract_json_ld(html):
    """Extract JSON-LD structured data from HTML if present."""
    events = []
    # Look for JSON-LD script tags
    pattern = re.compile(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        re.DOTALL | re.IGNORECASE
    )
    for match in pattern.finditer(html):
        try:
            data = json.loads(match.group(1))
            if isinstance(data, list):
                events.extend(data)
            elif isinstance(data, dict):
                events.append(data)
        except json.JSONDecodeError:
            continue
    return events


def extract_next_data(html):
    """Extract __NEXT_DATA__ or similar embedded JSON from the page."""
    events = []

    # Try __NEXT_DATA__ pattern (Next.js apps)
    next_data_match = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        html, re.DOTALL
    )
    if next_data_match:
        try:
            data = json.loads(next_data_match.group(1))
            # Navigate the Next.js data structure to find events
            props = data.get('props', {}).get('pageProps', {})
            bundle = props.get('bundle', props.get('data', {}))
            if isinstance(bundle, dict):
                event_list = bundle.get('events', bundle.get('lineup', []))
                if isinstance(event_list, list):
                    events.extend(event_list)
        except (json.JSONDecodeError, AttributeError):
            pass

    # Try generic embedded JSON with event-like structures
    # Look for large JSON blobs that contain event data
    json_pattern = re.compile(r'\{["\']?events?["\']?\s*:\s*\[.*?\]', re.DOTALL)
    for match in json_pattern.finditer(html):
        try:
            # Try to parse a complete JSON object starting from this match
            start = match.start()
            # Find a balanced JSON object
            depth = 0
            for i in range(start, min(start + 100000, len(html))):
                if html[i] == '{':
                    depth += 1
                elif html[i] == '}':
                    depth -= 1
                    if depth == 0:
                        blob = html[start:i + 1]
                        data = json.loads(blob)
                        if 'events' in data and isinstance(data['events'], list):
                            events.extend(data['events'])
                        elif 'event' in data and isinstance(data['event'], list):
                            events.extend(data['event'])
                        break
        except (json.JSONDecodeError, IndexError):
            continue

    return events


def extract_event_links(html):
    """Extract DICE event URLs from the bundle page HTML."""
    links = []
    # Match DICE event URLs
    pattern = re.compile(r'href="(https://dice\.fm/event/[^"]+)"', re.IGNORECASE)
    for match in pattern.finditer(html):
        url = match.group(1)
        if url not in links:
            links.append(url)

    # Also try relative paths
    rel_pattern = re.compile(r'href="(/event/[^"]+)"', re.IGNORECASE)
    for match in rel_pattern.finditer(html):
        url = 'https://dice.fm' + match.group(1)
        if url not in links:
            links.append(url)

    return links


def parse_event_from_url(url):
    """Extract event name, date hints from a DICE event URL slug."""
    # URL pattern: /event/SLUG-date-venue-city-tickets
    slug = url.rstrip('/').split('/')[-1]

    # Remove the hash prefix (e.g., 'mx8y59-')
    slug_parts = slug.split('-')
    if slug_parts and re.match(r'^[a-z0-9]{4,8}$', slug_parts[0]):
        slug_parts = slug_parts[1:]

    # Remove trailing 'tickets'
    if slug_parts and slug_parts[-1] == 'tickets':
        slug_parts = slug_parts[:-1]

    slug_text = ' '.join(slug_parts)
    return {
        'slug': slug_text,
        'url': url,
    }


def scrape_event_page(url):
    """Scrape an individual DICE event page for details."""
    try:
        html = fetch_page(url)
    except Exception as e:
        print(f"    Failed to fetch event page: {e}")
        return None

    event = {'url': url}

    # Extract from JSON-LD
    ld_events = extract_json_ld(html)
    for ld in ld_events:
        if ld.get('@type') in ('Event', 'MusicEvent'):
            event['name'] = ld.get('name', '')
            event['date'] = ld.get('startDate', '')
            event['endDate'] = ld.get('endDate', '')
            event['venue'] = ''
            location = ld.get('location', {})
            if isinstance(location, dict):
                event['venue'] = location.get('name', '')
            elif isinstance(location, str):
                event['venue'] = location

            # Artists / performers
            performers = ld.get('performer', ld.get('performers', []))
            if isinstance(performers, list):
                event['artists'] = [
                    p.get('name', p) if isinstance(p, dict) else str(p)
                    for p in performers
                ]
            elif isinstance(performers, dict):
                event['artists'] = [performers.get('name', '')]
            else:
                event['artists'] = []

            # Price
            offers = ld.get('offers', {})
            if isinstance(offers, dict):
                event['price'] = offers.get('price', '')
                event['currency'] = offers.get('priceCurrency', 'USD')
            elif isinstance(offers, list) and offers:
                event['price'] = offers[0].get('price', '')
                event['currency'] = offers[0].get('priceCurrency', 'USD')
            break

    # Fallback: extract name from <title> tag
    if not event.get('name'):
        title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.DOTALL | re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            # Clean up DICE title format: "Event Name | DICE"
            title = re.sub(r'\s*\|\s*DICE.*$', '', title)
            title = re.sub(r'\s*-\s*DICE.*$', '', title)
            event['name'] = title

    # Fallback: extract from og:title meta
    if not event.get('name'):
        og_match = re.search(
            r'<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\']',
            html, re.IGNORECASE
        )
        if og_match:
            event['name'] = og_match.group(1).strip()

    # Extract price from page content if not in JSON-LD
    if not event.get('price'):
        price_match = re.search(r'\$(\d+(?:\.\d{2})?)', html)
        if price_match:
            event['price'] = price_match.group(1)
            event['currency'] = 'USD'

    return event


def normalize_name(name):
    """Normalize an event name for comparison."""
    name = name.lower()
    # Remove common prefixes/suffixes
    name = re.sub(r'\s*miami\s*music\s*week\s*', ' ', name)
    name = re.sub(r'\s*mmw\s*20\d{2}\s*', ' ', name)
    name = re.sub(r'\s*mmw\s*', ' ', name)
    name = re.sub(r'\s*presents?\s*', ' ', name)
    # Remove punctuation
    name = re.sub(r'[^\w\s]', '', name)
    # Collapse whitespace
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def match_existing_events(dice_events, existing_events):
    """Match DICE events against existing data.js events.

    Returns a list of dicts with 'dice_event', 'matched_id' (or None), 'is_new'.
    """
    existing_normalized = {}
    for ev in existing_events:
        norm = normalize_name(ev['name'])
        existing_normalized[norm] = ev['id']
        # Also index by headliner
        if ev.get('headliner'):
            existing_normalized[ev['headliner'].lower()] = ev['id']

    results = []
    for dev in dice_events:
        dice_name = dev.get('name', dev.get('slug', ''))
        norm = normalize_name(dice_name)

        matched_id = None

        # Try exact normalized match
        if norm in existing_normalized:
            matched_id = existing_normalized[norm]
        else:
            # Try partial matching: check if key words from DICE name appear
            # in any existing event name
            dice_words = set(norm.split())
            for exist_norm, eid in existing_normalized.items():
                exist_words = set(exist_norm.split())
                # If significant overlap, consider it a match
                overlap = dice_words & exist_words
                if len(overlap) >= 2 and len(overlap) / max(len(dice_words), 1) > 0.4:
                    matched_id = eid
                    break

        results.append({
            'dice_event': dev,
            'matched_id': matched_id,
            'is_new': matched_id is None,
        })

    return results


def main():
    print("=" * 60)
    print("DICE MMW Event Scraper")
    print("=" * 60)

    # Load existing events
    print("\nLoading existing events from data.js...")
    try:
        existing_events = parse_events()
    except Exception as e:
        print(f"  Warning: could not parse existing events: {e}")
        existing_events = []

    # Fetch the bundle page
    print(f"\nFetching DICE bundle page: {DICE_BUNDLE_URL}")
    try:
        html = fetch_page(DICE_BUNDLE_URL)
    except Exception as e:
        print(f"  FATAL: Could not fetch bundle page: {e}")
        # Write empty results so downstream steps don't break
        save_json(DICE_EVENTS_FILE, {
            'updated': datetime.now(timezone.utc).isoformat(),
            'source': DICE_BUNDLE_URL,
            'events': [],
            'new_events': [],
            'error': str(e),
        })
        return

    print(f"  Fetched {len(html)} bytes")

    # Strategy 1: Extract embedded JSON data
    print("\nExtracting embedded JSON data...")
    embedded_events = extract_next_data(html)
    print(f"  Found {len(embedded_events)} events in embedded data")

    # Strategy 2: Extract JSON-LD
    print("\nExtracting JSON-LD structured data...")
    ld_events = extract_json_ld(html)
    print(f"  Found {len(ld_events)} JSON-LD objects")

    # Strategy 3: Extract event links and scrape individually
    print("\nExtracting event links from bundle page...")
    event_links = extract_event_links(html)
    print(f"  Found {len(event_links)} event links")

    # Scrape individual event pages (with rate limiting)
    dice_events = []

    # First, add any events from embedded data
    for ev in embedded_events:
        if isinstance(ev, dict):
            dice_events.append({
                'name': ev.get('name', ev.get('title', '')),
                'date': ev.get('date', ev.get('startDate', '')),
                'venue': ev.get('venue', {}).get('name', '') if isinstance(ev.get('venue'), dict) else ev.get('venue', ''),
                'artists': ev.get('artists', ev.get('lineup', [])),
                'price': ev.get('price', ''),
                'url': ev.get('url', ev.get('link', '')),
                'source': 'embedded_json',
            })

    # Then scrape individual event pages
    if event_links:
        print(f"\nScraping {len(event_links)} individual event pages...")
        for i, link in enumerate(event_links):
            print(f"  [{i + 1}/{len(event_links)}] {link[:80]}...")

            # Check if we already have this event from embedded data
            already_found = any(
                e.get('url', '').rstrip('/') == link.rstrip('/')
                for e in dice_events
            )
            if already_found:
                print(f"    -> Already have from embedded data, skipping")
                continue

            event = scrape_event_page(link)
            if event and event.get('name'):
                event['source'] = 'page_scrape'
                dice_events.append(event)
                print(f"    -> {event['name']}")
            else:
                # Use URL slug as fallback
                parsed = parse_event_from_url(link)
                parsed['source'] = 'url_slug'
                dice_events.append(parsed)
                print(f"    -> (from URL) {parsed.get('slug', 'unknown')}")

            # Rate limiting
            time.sleep(REQUEST_DELAY)
    elif not dice_events:
        # If no links found either, try to extract event info from
        # the bundle page HTML directly
        print("\nNo event links found. Trying direct HTML extraction...")
        # Look for event card patterns
        card_pattern = re.compile(
            r'class="[^"]*event[^"]*"[^>]*>.*?'
            r'(?:class="[^"]*name[^"]*"[^>]*>([^<]+)<|'
            r'class="[^"]*title[^"]*"[^>]*>([^<]+)<)',
            re.DOTALL | re.IGNORECASE
        )
        for match in card_pattern.finditer(html):
            name = match.group(1) or match.group(2) or ''
            if name.strip():
                dice_events.append({
                    'name': name.strip(),
                    'source': 'html_extraction',
                    'url': DICE_BUNDLE_URL,
                })

    print(f"\nTotal DICE events found: {len(dice_events)}")

    # Match against existing events
    print("\nMatching against existing data.js events...")
    results = match_existing_events(dice_events, existing_events)

    new_events = [r for r in results if r['is_new']]
    matched_events = [r for r in results if not r['is_new']]

    print(f"  Matched to existing: {len(matched_events)}")
    print(f"  NEW events: {len(new_events)}")

    if new_events:
        print("\n  New events not in data.js:")
        for r in new_events:
            ev = r['dice_event']
            name = ev.get('name', ev.get('slug', 'unknown'))
            print(f"    - {name}")

    # Build output
    output = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'source': DICE_BUNDLE_URL,
        'total_found': len(dice_events),
        'matched_existing': len(matched_events),
        'new_count': len(new_events),
        'events': [
            {
                'name': r['dice_event'].get('name', r['dice_event'].get('slug', '')),
                'date': r['dice_event'].get('date', ''),
                'venue': r['dice_event'].get('venue', ''),
                'artists': r['dice_event'].get('artists', []),
                'price': r['dice_event'].get('price', ''),
                'url': r['dice_event'].get('url', ''),
                'matched_id': r['matched_id'],
                'is_new': r['is_new'],
            }
            for r in results
        ],
        'new_events': [
            {
                'name': r['dice_event'].get('name', r['dice_event'].get('slug', '')),
                'date': r['dice_event'].get('date', ''),
                'venue': r['dice_event'].get('venue', ''),
                'artists': r['dice_event'].get('artists', []),
                'price': r['dice_event'].get('price', ''),
                'url': r['dice_event'].get('url', ''),
            }
            for r in results if r['is_new']
        ],
    }

    save_json(DICE_EVENTS_FILE, output)
    print(f"\nDone. Results written to {DICE_EVENTS_FILE}")


if __name__ == '__main__':
    main()
