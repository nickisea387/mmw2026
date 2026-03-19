#!/usr/bin/env python3
"""Scrape Reddit JSON API for event/artist mentions and write reddit_signals.json.

Uses only the public Reddit JSON endpoints (no auth required).
Searches across configured subreddits for event names and headliner artists.
"""
import json
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone

# Allow running from repo root or scripts/
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from config import (
    REDDIT_SUBREDDITS, REDDIT_USER_AGENT, REDDIT_DELAY,
    REDDIT_SIGNALS_FILE, parse_events, save_json,
)


def reddit_search(query, subreddit=None, sort='new', time_filter='week', limit=25):
    """Search Reddit and return list of result dicts. Returns [] on failure."""
    if subreddit:
        base = f"https://www.reddit.com/r/{subreddit}/search.json"
        params = {
            'q': query,
            'sort': sort,
            't': time_filter,
            'limit': str(limit),
            'restrict_sr': 'on',
        }
    else:
        base = "https://www.reddit.com/search.json"
        params = {
            'q': query,
            'sort': sort,
            't': time_filter,
            'limit': str(limit),
        }

    url = base + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'User-Agent': REDDIT_USER_AGENT,
    })

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            children = data.get('data', {}).get('children', [])
            return children
    except Exception as e:
        print(f"    Reddit search failed for '{query}': {e}")
        return []


def count_signals(query_terms, subreddits):
    """Search Reddit for each query term across subreddits.

    Returns (total_posts, total_comments_estimate).
    """
    total_posts = 0
    total_comments = 0
    seen_ids = set()

    for term in query_terms:
        for sub in subreddits:
            results = reddit_search(term, subreddit=sub)
            for child in results:
                post = child.get('data', {})
                post_id = post.get('id', '')
                if post_id and post_id not in seen_ids:
                    seen_ids.add(post_id)
                    total_posts += 1
                    total_comments += post.get('num_comments', 0)
            time.sleep(REDDIT_DELAY)

    return total_posts, total_comments


def main():
    print("=" * 60)
    print("Reddit Signal Scraper")
    print("=" * 60)

    events = parse_events()
    if not events:
        print("No events found. Exiting.")
        return

    signals = {}
    raw_totals = []  # (event_id, posts+comments) for normalization

    for ev in events:
        eid = ev['id']
        name = ev['name']
        headliner = ev['headliner']

        # Build search queries — event name and headliner (if available)
        query_terms = [name]
        if headliner and headliner.lower() not in name.lower():
            query_terms.append(headliner)

        print(f"  [{eid}] {name} — searching {len(query_terms)} terms across {len(REDDIT_SUBREDDITS)} subs...")

        posts, comments = count_signals(query_terms, REDDIT_SUBREDDITS)
        total = posts + comments

        signals[str(eid)] = {
            'posts': posts,
            'comments': comments,
        }
        raw_totals.append((str(eid), total))

        print(f"    -> posts={posts}, comments={comments}")

    # Normalize scores 0-1 based on relative activity
    max_total = max((t for _, t in raw_totals), default=1)
    if max_total == 0:
        max_total = 1

    for eid_str, total in raw_totals:
        signals[eid_str]['score'] = round(total / max_total, 3)

    output = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'signals': signals,
    }
    save_json(REDDIT_SIGNALS_FILE, output)

    nonzero = sum(1 for _, t in raw_totals if t > 0)
    print(f"\nDone. {nonzero}/{len(events)} events have Reddit activity.")


if __name__ == '__main__':
    main()
