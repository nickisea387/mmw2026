#!/usr/bin/env python3
"""Refresh artist images from Deezer API and write to artist_images.js"""
import json, urllib.request, urllib.parse, re, os

DATA_FILE = os.path.join(os.path.dirname(__file__), '..', 'data.js')
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), '..', 'artist_images.js')

with open(DATA_FILE) as f:
    content = f.read()

# Extract headliners from EVENTS
artists_raw = re.findall(r'artists:"([^"]+)"', content)
headliners = {}
for a in artists_raw:
    first = a.split(',')[0].strip()
    first = re.sub(r'\s*b2b\s+.*', '', first, flags=re.IGNORECASE)
    first = re.sub(r'\s*\(.*?\)', '', first).strip()
    if first and first != 'TBA':
        headliners[first] = None

# Load existing cache
existing = {}
if os.path.exists(OUTPUT_FILE):
    with open(OUTPUT_FILE) as f:
        m = re.search(r'= ({.*?});', f.read(), re.DOTALL)
        if m:
            try: existing = json.loads(m.group(1))
            except: pass

# Fetch missing from Deezer
fetched = 0
for name in headliners:
    if name in existing and existing[name]:
        headliners[name] = existing[name]
        continue
    try:
        url = f"https://api.deezer.com/search/artist?q={urllib.parse.quote(name)}&limit=1"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            if data.get('data') and data['data'][0].get('picture_big'):
                headliners[name] = data['data'][0]['picture_big']
                fetched += 1
    except Exception as e:
        print(f"Failed for {name}: {e}")

result = {k: v for k, v in headliners.items() if v}
js = "const ARTIST_IMAGES = " + json.dumps(result, indent=2) + ";\n"
with open(OUTPUT_FILE, 'w') as f:
    f.write(js)

print(f"Total: {len(result)} artists, {fetched} newly fetched")
