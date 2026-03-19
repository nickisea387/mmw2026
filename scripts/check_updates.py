#!/usr/bin/env python3
"""Calculate trending scores for all events and write trending.js.

Formula per event:
  mention_score   = mentions * 3         (max 21, since mentions max ~7)
  hype_score      = hype * 2             (max 10, since hype max 5)
  bandwagon_score = bandwagon            (max 5)
  reddit_score    = reddit_signal * 20   (max 20, signal is 0-1)
  soldout_bonus   = 10 if sold out
  dark_horse      = 8 if bandwagon <= 2 AND (mentions >= 4 OR reddit_score >= 10)
  momentum        = (current_reddit - previous_reddit) * 15  (max 15)

  total = sum of all above

Events with total >= TRENDING_THRESHOLD are TRENDING.

Outputs:
  - trending.js           (TRENDING_IDS array for the front end)
  - data/trend_scores.json (full breakdown for debugging)
  - data/previous_reddit.json (snapshot of current reddit scores for next run's momentum calc)
"""
import json
from datetime import datetime, timezone

# Allow running from repo root or scripts/
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from config import (
    TRENDING_THRESHOLD,
    REDDIT_SIGNALS_FILE,
    TICKET_SIGNALS_FILE,
    TREND_SCORES_FILE,
    PREVIOUS_REDDIT_FILE,
    TRENDING_JS,
    parse_events,
    load_json,
    save_json,
)


def main():
    print("=" * 60)
    print("Trending Score Calculator")
    print("=" * 60)

    # ── Load data sources ─────────────────────────────────────────────────────
    events = parse_events()
    if not events:
        print("No events found. Exiting.")
        return

    # Load optional signal files
    reddit_data = load_json(REDDIT_SIGNALS_FILE)
    reddit_signals = reddit_data.get('signals', {}) if reddit_data else {}
    print(f"  Reddit signals: {len(reddit_signals)} events" if reddit_signals else "  Reddit signals: not available")

    ticket_data = load_json(TICKET_SIGNALS_FILE)
    ticket_signals = ticket_data.get('signals', {}) if ticket_data else {}
    print(f"  Ticket signals: {len(ticket_signals)} events" if ticket_signals else "  Ticket signals: not available")

    previous_reddit = load_json(PREVIOUS_REDDIT_FILE) or {}
    print(f"  Previous reddit scores: {len(previous_reddit)} events" if previous_reddit else "  Previous reddit scores: not available")

    # ── Calculate scores ──────────────────────────────────────────────────────
    trending_ids = []
    score_details = {}
    current_reddit_snapshot = {}

    for ev in events:
        eid = str(ev['id'])
        mentions = ev['mentions']
        hype = ev['hype']
        bandwagon = ev['bandwagon']

        # Base scores from data.js
        mention_score = min(mentions * 3, 21)
        hype_score = min(hype * 2, 10)
        bandwagon_score = min(bandwagon, 5)

        # Reddit score
        reddit_signal = 0.0
        if eid in reddit_signals:
            reddit_signal = reddit_signals[eid].get('score', 0.0)
        reddit_score = min(reddit_signal * 20, 20)
        current_reddit_snapshot[eid] = reddit_signal

        # Sold-out bonus
        soldout_bonus = 0
        if eid in ticket_signals:
            if ticket_signals[eid].get('soldOut', False):
                soldout_bonus = 10

        # Dark horse: low bandwagon but high signal
        dark_horse = 0
        if bandwagon <= 2 and (mentions >= 4 or reddit_score >= 10):
            dark_horse = 8

        # Momentum: change in reddit signal since last run
        prev_signal = previous_reddit.get(eid, 0.0)
        momentum_raw = (reddit_signal - prev_signal) * 15
        momentum = max(0, min(momentum_raw, 15))

        # Total
        total = (mention_score + hype_score + bandwagon_score +
                 reddit_score + soldout_bonus + dark_horse + momentum)
        total = round(total, 2)

        if total >= TRENDING_THRESHOLD:
            trending_ids.append(ev['id'])

        score_details[eid] = {
            'name': ev['name'],
            'mention_score': mention_score,
            'hype_score': hype_score,
            'bandwagon_score': bandwagon_score,
            'reddit_score': round(reddit_score, 2),
            'soldout_bonus': soldout_bonus,
            'dark_horse': dark_horse,
            'momentum': round(momentum, 2),
            'total': total,
            'trending': total >= TRENDING_THRESHOLD,
        }

    # Sort trending IDs for deterministic output
    trending_ids.sort()

    # ── Write outputs ─────────────────────────────────────────────────────────

    # 1. trending.js for the front end
    with open(TRENDING_JS, 'w') as f:
        f.write(f"const TRENDING_IDS = {json.dumps(trending_ids)};\n")
    print(f"\n  Written: {TRENDING_JS}")

    # 2. Full score breakdown for debugging
    output = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'threshold': TRENDING_THRESHOLD,
        'trending_count': len(trending_ids),
        'total_events': len(events),
        'scores': score_details,
    }
    save_json(TREND_SCORES_FILE, output)

    # 3. Snapshot current reddit scores for next run's momentum
    save_json(PREVIOUS_REDDIT_FILE, current_reddit_snapshot)

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n  Trending: {len(trending_ids)} / {len(events)} events (threshold: {TRENDING_THRESHOLD})")
    print(f"  IDs: {trending_ids}")

    # Show top 10 by score
    ranked = sorted(score_details.items(), key=lambda x: x[1]['total'], reverse=True)
    print(f"\n  Top 10 events by score:")
    for eid, detail in ranked[:10]:
        tag = " << TRENDING" if detail['trending'] else ""
        print(f"    [{eid}] {detail['total']:6.1f}  {detail['name']}{tag}")


if __name__ == '__main__':
    main()
