#!/usr/bin/env python3
"""Shared configuration for MMW data refresh scripts."""

import os
import re
import json

# ── Reddit settings ──────────────────────────────────────────────────────────
REDDIT_SUBREDDITS = ['EDM', 'aves', 'UKFestivals', 'housemusic', 'techno', 'MiamiMusic', 'DJs', 'Techno', 'electronicmusic', 'trance', 'deephouse', 'miami', 'festivals']
REDDIT_USER_AGENT = 'mmw-event-tracker/1.0'
REDDIT_DELAY = 2.0  # seconds between requests

# ── Trending thresholds ──────────────────────────────────────────────────────
TRENDING_THRESHOLD = 35

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA_JS = os.path.join(ROOT_DIR, 'data.js')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
TRENDING_JS = os.path.join(ROOT_DIR, 'trending.js')

REDDIT_SIGNALS_FILE = os.path.join(DATA_DIR, 'reddit_signals.json')
TICKET_SIGNALS_FILE = os.path.join(DATA_DIR, 'ticket_signals.json')
TREND_SCORES_FILE = os.path.join(DATA_DIR, 'trend_scores.json')
PREVIOUS_REDDIT_FILE = os.path.join(DATA_DIR, 'previous_reddit.json')


def load_json(path):
    """Load a JSON file, returning None if it doesn't exist or is invalid."""
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"  Warning: could not load {path}: {e}")
        return None


def save_json(path, data):
    """Write data as pretty-printed JSON."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"  Written: {path}")


def parse_events():
    """Parse EVENTS array from data.js and return list of event dicts.

    Each dict has keys: id, name, artists (full string), headliner (first artist),
    hype, mentions, bandwagon.
    """
    with open(DATA_JS) as f:
        content = f.read()

    events = []
    # Match each event object in the EVENTS array
    for m in re.finditer(
        r'\{id:(\d+).*?name:"([^"]+)".*?artists:"([^"]+)".*?hype:(\d+),mentions:(\d+),bandwagon:(\d+)',
        content
    ):
        eid, name, artists_str, hype, mentions, bandwagon = m.groups()

        # Extract headliner (first artist, cleaned)
        headliner = artists_str.split(',')[0].strip()
        headliner = re.sub(r'\s*b2b\s+.*', '', headliner, flags=re.IGNORECASE)
        headliner = re.sub(r'\s*\(.*?\)', '', headliner).strip()

        events.append({
            'id': int(eid),
            'name': name,
            'artists': artists_str,
            'headliner': headliner if headliner != 'TBA' else '',
            'hype': int(hype),
            'mentions': int(mentions),
            'bandwagon': int(bandwagon),
        })

    print(f"  Parsed {len(events)} events from data.js")
    return events
