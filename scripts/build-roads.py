#!/usr/bin/env python3
"""Build the offline Singapore expressway bundle from an OSM Overpass JSON extract.

Usage: python scripts/build-roads.py /path/to/osm.json
The input used for the checked-in bundle is documented in roads.json metadata.
"""
import json
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

REFS = ('AYE', 'BKE', 'CTE', 'ECP', 'KJE', 'KPE', 'MCE', 'PIE', 'SLE', 'TPE')
SOURCE_URL = 'https://github.com/madeinusmate/fix-singapore-gp/blob/6368d82cd39a16c4e4488c8b7bd1d278e92b80f5/analysis/osm.json'
SOURCE_COMMIT = '6368d82cd39a16c4e4488c8b7bd1d278e92b80f5'


def distance_m(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_195 * math.cos(lat), (a[1] - b[1]) * 111_195)


def direction(coords):
    a, b = coords[0], coords[-1]
    dx = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    dy = b[1] - a[1]
    return ('E' if dx >= 0 else 'W') if abs(dx) >= abs(dy) else ('N' if dy >= 0 else 'S')


def speed_kmh(value):
    if not value:
        return None
    m = re.fullmatch(r'\s*(\d+)\s*(?:km/h|kph)?\s*', value)
    return int(m.group(1)) if m else None


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: python scripts/build-roads.py /path/to/osm.json')
    data = json.loads(Path(sys.argv[1]).read_text())
    ways = data['elements']
    mainline = [w for w in ways if w['tags'].get('highway') == 'motorway' and w['tags'].get('ref') in REFS and len(w.get('geometry', [])) > 1]
    by_node = defaultdict(list)
    roads = []
    for w in mainline:
        tags = w['tags']
        coords = [[round(p['lon'], 7), round(p['lat'], 7)] for p in w['geometry']]
        length = sum(distance_m(a, b) for a, b in zip(coords, coords[1:]))
        speed = speed_kmh(tags.get('maxspeed'))
        road = {
            'id': f"osm-way-{w['id']}", 'ref': tags['ref'],
            'name': tags.get('name') or tags['ref'], 'direction': direction(coords),
            'coordinates': coords, 'lengthM': round(length, 1),
            'speedLimit': speed, 'speedLimitSource': 'OSM maxspeed tag' if speed is not None else None,
            'tunnel': tags.get('tunnel') == 'yes', 'exits': [], 'nextRoadIds': []
        }
        roads.append(road)
        for i, node in enumerate(w['nodes']):
            if i < len(coords):
                by_node[node].append((road, i, w))

    # OSM motorway_link ways that begin on a mainline node are mapped exits.
    # A link without a destination tag is kept unnamed; no exit number is inferred.
    exit_seen = set()
    for ramp in ways:
        t = ramp['tags']
        if t.get('highway') != 'motorway_link' or not ramp.get('nodes'):
            continue
        node = ramp['nodes'][0]
        for road, i, source_way in by_node.get(node, []):
            key = (road['id'], ramp['id'])
            if key in exit_seen:
                continue
            exit_seen.add(key)
            offset = sum(distance_m(a, b) for a, b in zip(road['coordinates'][:i], road['coordinates'][1:i + 1]))
            destination = t.get('destination') or t.get('destination:street') or t.get('name')
            road['exits'].append({
                'id': f"osm-way-{ramp['id']}", 'name': destination,
                'ref': t.get('destination:ref'), 'offsetM': round(offset, 1),
                'coordinates': road['coordinates'][i], 'source': 'OSM motorway_link tags'
            })

    starts = defaultdict(list)
    for road, way in zip(roads, mainline):
        starts[(road['ref'], way['nodes'][0])].append(road['id'])
    for road, way in zip(roads, mainline):
        road['nextRoadIds'] = [x for x in starts.get((road['ref'], way['nodes'][-1]), []) if x != road['id']]
        road['exits'].sort(key=lambda x: (x['offsetM'], x['id']))

    by_id = {r['id']: r for r in roads}
    predecessors = {next_id for r in roads for next_id in r['nextRoadIds']}
    chains = []
    visited = set()
    for first in roads:
        if first['id'] in predecessors:
            continue
        members = []
        current = first
        while current and current['id'] not in visited:
            members.append(current)
            visited.add(current['id'])
            current = by_id[current['nextRoadIds'][0]] if current['nextRoadIds'] else None
        if not members:
            continue
        last = members[-1]
        chain_id = f"{first['ref']}-{first['id']}"
        travel_direction = direction([first['coordinates'][0], last['coordinates'][-1]])
        for member in members:
            member['chainId'] = chain_id
            member['travelDirection'] = travel_direction
        chains.append({
            'id': chain_id, 'ref': first['ref'], 'travelDirection': travel_direction,
            'start': first['coordinates'][0], 'end': last['coordinates'][-1],
            'lengthM': round(sum(member['lengthM'] for member in members), 1),
            'firstRoadId': first['id'], 'lastRoadId': last['id'],
            'segmentCount': len(members)
        })
    if sum(c['segmentCount'] for c in chains) != len(roads):
        raise ValueError('mainline topology has a cycle or overlapping chains')

    counts = Counter(r['ref'] for r in roads)
    known_speeds = Counter(r['ref'] for r in roads if r['speedLimit'] is not None)
    exit_counts = Counter(r['ref'] for r in roads for _ in r['exits'])
    out = {
        'metadata': {
            'source': SOURCE_URL, 'sourceCommit': SOURCE_COMMIT,
            'sourceCommitDate': '2026-10-19T15:53:30Z',
            'sourceAttribution': '© OpenStreetMap contributors',
            'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'coordinateOrder': 'longitude,latitude',
            'note': 'OSM map data is community mapped. Tagged speed limits are not independently verified against current legal limits. Unmapped limits and exits remain unknown.'
        },
        'coverage': {ref: {'segments': counts[ref], 'speedTaggedSegments': known_speeds[ref], 'mappedExitAttachments': exit_counts[ref]} for ref in REFS},
        'chains': chains,
        'roads': roads,
    }
    path = Path('dist/data/roads.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(',', ':')))
    print(json.dumps(out['coverage'], indent=2))
    print(f'{len(roads)} road segments, {path.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
