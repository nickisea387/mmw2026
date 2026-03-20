#!/usr/bin/env python3
"""Scrape Google News RSS for event/artist press mentions.

Uses Google News RSS feed (no auth, no API key) to count recent press mentions
for each event headliner + "miami music week" or venue name.
Writes results to data/news_signals.json
"""
import json
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from config import parse_events, save_json, DATA_DIR

NEWS_SIGNALS_FILE = os.path.join(DATA_DIR, 'news_signals.json')
USER_AGENT = 'Mozilla/5.0 (compatible; mmw-tracker/1.0)'
DELAY = 1.5  # seconds between requests


def search_google_news(query, max_results=20):
    """Search Google News RSS and return number of results."""
    try:
        url = f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl=en-US&gl=US&ceid=US:en"
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            root = ET.fromstring(data)
            items = root.findall('.//item')
            return len(items)
    except Exception as e:
        print(f"    Error: {e}")
        return 0


def main():
    print("=" * 60)
    print("Google News Scraper")
    print("=" * 60)

    events = parse_events()
    if not events:
        print("No events found.")
        return

    signals = {}
    max_mentions = 0

    for ev in events:
        eid = str(ev['id'])
        headliner = ev.get('headliner', '')
        event_name = ev['name']

        if not headliner or headliner == 'TBA':
            signals[eid] = {'articles': 0, 'score': 0}
            continue

        # Search for headliner + MMW context
        queries = [
            f'"{headliner}" "miami music week" 2026',
            f'"{headliner}" miami march 2026',
        ]

        total_articles = 0
        for q in queries:
            count = search_google_news(q)
            total_articles += count
            time.sleep(DELAY)

        signals[eid] = {'articles': total_articles, 'score': 0}
        if total_articles > max_mentions:
            max_mentions = total_articles

        status = f"🔥 {total_articles}" if total_articles > 5 else str(total_articles)
        print(f"  [{eid}] {headliner}: {status} articles")

    # Normalize scores 0-1
    if max_mentions > 0:
        for eid in signals:
            signals[eid]['score'] = round(signals[eid]['articles'] / max_mentions, 3)

    # Save
    output = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'source': 'google_news_rss',
        'signals': signals,
    }
    save_json(NEWS_SIGNALS_FILE, output)

    # Summary
    hot = [(eid, s) for eid, s in signals.items() if s['articles'] > 3]
    hot.sort(key=lambda x: x[1]['articles'], reverse=True)
    print(f"\n  Total events: {len(signals)}")
    print(f"  Events with 3+ articles: {len(hot)}")
    for eid, s in hot[:10]:
        ev = next((e for e in events if str(e['id']) == eid), None)
        name = ev['name'] if ev else eid
        print(f"    [{eid}] {s['articles']} articles - {name}")


if __name__ == '__main__':
    main()
