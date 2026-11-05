#!/usr/bin/env python3
"""Build the offline Singapore expressway bundle from an OSM Overpass JSON extract.

Usage: python scripts/build-roads.py /path/to/osm.json
The input used for the checked-in bundle is documented in roads.json metadata.
"""
import json
import gzip
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


def heading_deg(a, b):
    dx = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    dy = b[1] - a[1]
    return round(math.degrees(math.atan2(dx, dy)) % 360, 1)


def speed_kmh(value):
    if not value:
        return None
    m = re.fullmatch(r'\s*(\d+)\s*(?:km/h|kph)?\s*', value)
    speed = int(m.group(1)) if m else None
    return speed if speed is not None and 0 < speed <= 90 else None


def simplify(coords, tolerance_m=5):
    if len(coords) <= 2:
        return coords
    result = [coords[0]]
    for point in coords[1:-1]:
        if distance_m(result[-1], point) >= tolerance_m:
            result.append(point)
    result.append(coords[-1])
    return result


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

    # Only exact directed OSM node joins form route transitions. Motorway links
    # are bounded connector paths, never ordinary streets or proximity guesses.
    all_starts = defaultdict(list)
    for road, way in zip(roads, mainline):
        all_starts[way['nodes'][0]].append(road)
    links = []
    for way in ways:
        if way['tags'].get('highway') != 'motorway_link' or len(way.get('geometry', [])) < 2:
            continue
        if way['tags'].get('oneway') == '-1':
            links.append({**way, 'nodes': way['nodes'][::-1], 'geometry': way['geometry'][::-1]})
        else:
            links.append(way)
        if way['tags'].get('oneway') == 'no':
            links.append({**way, 'id': f"{way['id']}-reverse", 'nodes': way['nodes'][::-1],
                          'geometry': way['geometry'][::-1]})
    link_starts = defaultdict(list)
    connectors = []
    for link in links:
        t = link['tags']
        coords = [[round(p['lon'], 7), round(p['lat'], 7)] for p in link['geometry']]
        length = round(sum(distance_m(a, b) for a, b in zip(coords, coords[1:])), 1)
        connector = {'id': f"osm-way-{link['id']}", 'name': t.get('name'),
                     'highway': 'motorway_link', 'coordinates': coords,
                     'speedLimit': speed_kmh(t.get('maxspeed')), 'lengthM': length,
                     'destination': t.get('destination'), 'ref': t.get('destination:ref'),
                     'source': 'OSM motorway_link way',
                     'startNode': link['nodes'][0], 'endNode': link['nodes'][-1]}
        connectors.append(connector)
        link_starts[connector['startNode']].append(connector)
    for road, way in zip(roads, mainline):
        transitions = [{'roadId': target['id'], 'connectorIds': [], 'lengthM': 0}
                       for target in all_starts.get(way['nodes'][-1], []) if target['id'] != road['id']]
        frontier = [(c, [c]) for c in link_starts.get(way['nodes'][-1], [])]
        while frontier:
            current, path = frontier.pop()
            length = sum(c['lengthM'] for c in path)
            if length > 2000 or len(path) > 4:
                continue
            for target in all_starts.get(current['endNode'], []):
                if target['id'] != road['id'] and target['ref'] != road['ref']:
                    transitions.append({'roadId': target['id'],
                                        'connectorIds': [c['id'] for c in path], 'lengthM': round(length, 1)})
            if len(path) < 4:
                for nxt in link_starts.get(current['endNode'], []):
                    if nxt['id'] not in {c['id'] for c in path}:
                        frontier.append((nxt, path + [nxt]))
        road['routeNextRoadIds'] = transitions
    for connector in connectors:
        connector.pop('startNode')
        connector.pop('endNode')

    # An on-ramp entry boundary is the exact shared node where a directed
    # motorway_link ends on a mainline way. Preserve source node and bearings;
    # heading gate is guidance, not an observed traffic rule.
    entries = []
    entry_seen = set()
    for link in links:
        node = link['nodes'][-1]
        geometry = link['geometry']
        if len(geometry) < 2:
            continue
        ramp_tail = [[p['lon'], p['lat']] for p in geometry[-2:]]
        for road, i, source_way in by_node.get(node, []):
            if i >= len(road['coordinates']) - 1:
                continue
            key = (link['id'], road['id'])
            if key in entry_seen:
                continue
            entry_seen.add(key)
            entries.append({'id': f"entry-{link['id']}-{source_way['id']}",
                            'roadId': road['id'], 'rampId': f"osm-way-{link['id']}",
                            'osmNodeId': node, 'coordinate': road['coordinates'][i],
                            'rampHeadingDeg': heading_deg(*ramp_tail),
                            'mainlineHeadingDeg': heading_deg(road['coordinates'][i], road['coordinates'][i + 1]),
                            'headingGateDeg': 60, 'source': 'exact shared OSM node'})

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
            'note': 'OSM map data is community mapped. Tagged speed limits are not independently verified against current legal limits. Untagged or implausible speed limits use an assumed 50 km/h comparison reference in the app; this is not a verified legal limit. Unmapped exits remain unknown.'
        },
        'coverage': {ref: {'segments': counts[ref], 'speedTaggedSegments': known_speeds[ref], 'mappedExitAttachments': exit_counts[ref]} for ref in REFS},
        'chains': chains,
        'connectors': connectors,
        'entries': entries,
        'roads': roads,
    }
    path = Path('dist/data/roads.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the mainline bundle stable; nearby road identification uses this separate file.
    local_classes = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
                     'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
                     'residential', 'unclassified', 'living_street', 'service'}
    mainline_ids = {w['id'] for w in mainline}
    local = []
    local_source = []
    for w in ways:
        t = w['tags']
        if w['id'] in mainline_ids or t.get('highway') not in local_classes or len(w.get('geometry', [])) < 2:
            continue
        if t.get('motor_vehicle') in {'no', 'private'} or t.get('vehicle') == 'no' or t.get('access') in {'no', 'private'}:
            continue
        coords = simplify([[round(p['lon'], 5), round(p['lat'], 5)] for p in w['geometry']])
        if t.get('oneway') == '-1':
            coords.reverse()
        oneway = t.get('oneway') in {'yes', '1', 'true', '-1'} or (t.get('oneway') != 'no' and (t.get('junction') == 'roundabout' or t.get('highway') in {'motorway', 'motorway_link'}))
        local.append({'id': f"osm-way-{w['id']}", 'name': t.get('name'), 'ref': t.get('ref'),
                      'highway': t['highway'], 'coordinates': coords,
                      'speedLimit': speed_kmh(t.get('maxspeed')),
                      'oneway': oneway, 'expressway': False,
                      'destination': t.get('destination') or t.get('destination:street')})
        local_source.append(w)
    local_ends = defaultdict(list)
    local_starts = defaultdict(list)
    for w in local_source:
        if w['tags'].get('highway') == 'motorway_link':
            continue
        nodes = w['nodes'][::-1] if w['tags'].get('oneway') == '-1' else w['nodes']
        local_ends[nodes[-1]].append(f"osm-way-{w['id']}")
        local_starts[nodes[0]].append(f"osm-way-{w['id']}")
        t = w['tags']
        oneway = t.get('oneway') in {'yes', '1', 'true', '-1'} or (t.get('oneway') != 'no' and (t.get('junction') == 'roundabout' or t.get('highway') in {'motorway', 'motorway_link'}) )
        if not oneway:
            local_ends[nodes[0]].append(f"osm-way-{w['id']}")
            local_starts[nodes[-1]].append(f"osm-way-{w['id']}")
    link_meta = []
    for link in links:
        start_node, end_node = link['nodes'][0], link['nodes'][-1]
        from_mainline = sorted({r['id'] for r, i, w in by_node.get(start_node, []) if i > 0})
        to_mainline = sorted({r['id'] for r, i, w in by_node.get(end_node, []) if i < len(w['nodes']) - 1})
        link_meta.append({
            'id': f"osm-way-{link['id']}", 'startNodeId': start_node, 'endNodeId': end_node,
            'startCoordinate': [link['geometry'][0]['lon'], link['geometry'][0]['lat']],
            'endCoordinate': [link['geometry'][-1]['lon'], link['geometry'][-1]['lat']],
            'nextLinkIds': [c['id'] for c in link_starts.get(end_node, []) if c['id'] != f"osm-way-{link['id']}"],
            'fromMainlineRoadIds': from_mainline, 'toMainlineRoadIds': to_mainline,
            'fromLocalRoadIds': sorted(set(local_ends.get(start_node, []))),
            'toLocalRoadIds': sorted(set(local_starts.get(end_node, [])))
        })
    out['rampGraph'] = {'source': 'exact directed OSM shared nodes', 'maxPathLengthM': 5000,
                        'maxPathLinks': 64, 'links': link_meta}
    meta_by_id = {m['id']: m for m in link_meta}
    connector_by_id = {c['id']: c for c in connectors}
    paths = []
    path_seen = set()
    truncated_searches = 0
    unresolved_ends = 0
    for first in link_meta:
        origins = [('mainline', rid) for rid in first['fromMainlineRoadIds']]
        origins += [('local', rid) for rid in first['fromLocalRoadIds']]
        if not origins:
            continue
        frontier = [(first['id'], [first['id']], connector_by_id[first['id']]['lengthM'])]
        while frontier:
            current_id, chain, length = frontier.pop()
            current = meta_by_id[current_id]
            if length > 5000 or len(chain) > 64:
                truncated_searches += 1
                continue
            destinations = [('mainline', rid) for rid in current['toMainlineRoadIds']]
            destinations += [('local', rid) for rid in current['toLocalRoadIds']]
            for origin_kind, origin_id in origins:
                for dest_kind, dest_id in destinations:
                    if origin_kind == 'local' and dest_kind == 'mainline':
                        kind = 'joining'
                    elif origin_kind == 'mainline' and dest_kind == 'local':
                        kind = 'leaving'
                    elif origin_kind == 'mainline' and dest_kind == 'mainline':
                        kind = 'transfer'
                    else:
                        continue
                    key = (kind, origin_id, dest_id, tuple(chain))
                    if key in path_seen:
                        continue
                    path_seen.add(key)
                    paths.append({'kind': kind, 'fromRoadId': origin_id, 'toRoadId': dest_id,
                                  'linkIds': chain, 'lengthM': round(length, 1),
                                  'startCoordinate': first['startCoordinate'],
                                  'endCoordinate': current['endCoordinate']})
            # A mainline attachment ends this ramp path; further travel follows
            # the mainline graph instead of continuing through another ramp.
            if current['toMainlineRoadIds']:
                continue
            if not current['nextLinkIds'] and not current['toLocalRoadIds']:
                unresolved_ends += 1
            if len(chain) < 64:
                for next_id in current['nextLinkIds']:
                    if next_id not in chain:
                        frontier.append((next_id, chain + [next_id], length + connector_by_id[next_id]['lengthM']))
    out['rampGraph']['paths'] = paths
    out['rampGraph']['truncatedSearchCount'] = truncated_searches
    out['rampGraph']['unresolvedEndCount'] = unresolved_ends
    path.write_text(json.dumps(out, separators=(',', ':')))
    local_path = Path('dist/data/local-roads.json')
    local_path.write_text(json.dumps({'metadata': out['metadata'], 'roads': local}, separators=(',', ':')))
    Path(str(local_path) + '.gz').write_bytes(gzip.compress(local_path.read_bytes(), compresslevel=9, mtime=0))
    print(json.dumps(out['coverage'], indent=2))
    print(f'{len(roads)} road segments, {path.stat().st_size:,} bytes')
    print(f'{len(local)} local road segments, {local_path.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
