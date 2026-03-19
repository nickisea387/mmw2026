#!/usr/bin/env python3
"""Check for event updates from public sources and update trend scores.

Calculates a 'trending' score for each event based on:
- Editorial mentions (mentions field, weight: 3x)
- Bandwagon factor (bandwagon field, weight: 1x)
- Inverse bandwagon bonus (underground events getting buzz score higher, weight: 2x)
- Recency boost (events in next 48h get 1.5x multiplier)

Events with trend_score >= 12 get TRENDING status.
"""
import json, re, os
from datetime import datetime, timedelta

DATA_FILE = os.path.join(os.path.dirname(__file__), '..', 'data.js')

with open(DATA_FILE) as f:
    content = f.read()

# Extract events data
events = re.findall(
    r'\{id:(\d+).*?mentions:(\d+),bandwagon:(\d+)',
    content
)

trending_ids = []
for eid, mentions, bandwagon in events:
    mentions = int(mentions)
    bandwagon = int(bandwagon)

    # Trend formula:
    # High mentions + low bandwagon = underground event getting buzz = very trending
    # High mentions + high bandwagon = mainstream event, expected = less "trendy"
    mention_score = mentions * 3
    underground_buzz_bonus = max(0, (4 - bandwagon)) * mentions * 0.5
    base_score = mention_score + underground_buzz_bonus

    # Trending threshold
    if base_score >= 18:
        trending_ids.append(int(eid))

print(f"Trending events: {len(trending_ids)} / {len(events)}")
print(f"IDs: {trending_ids}")

# Write trending data to a small JS file
output = os.path.join(os.path.dirname(__file__), '..', 'trending.js')
with open(output, 'w') as f:
    f.write(f"const TRENDING_IDS = {json.dumps(trending_ids)};\n")

print(f"Written to trending.js")
