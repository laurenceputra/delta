# Singapore expressway data

`dist/data/roads.json` is an offline extract of OpenStreetMap mainline motorway ways for AYE, BKE, CTE, ECP, KJE, KPE, MCE, PIE, SLE, and TPE. It was generated from [the committed Singapore Overpass export](https://github.com/madeinusmate/fix-singapore-gp/blob/6368d82cd39a16c4e4488c8b7bd1d278e92b80f5/analysis/osm.json) in `madeinusmate/fix-singapore-gp` (commit dated 2026-10-19). The original export does not include an OSM snapshot timestamp. Data: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

To update, download a current Overpass JSON extract containing Singapore motorway and motorway_link ways with geometry and tags, then run:

```sh
python scripts/build-roads.py path/to/osm.json
```

The builder currently pins the source URL and commit in metadata. Update those constants when using a different extract. The output includes per-way coordinates in `[longitude, latitude]` order, mapped `maxspeed` values, and motorway_link destinations at shared source nodes. `nextRoadIds` preserves direct OSM mainline topology. `chains` lists connected directed sequences; a short PIE branch merges into the westbound mainline. A chain's `travelDirection` is its end-to-end compass bearing, while each way's `direction` is local bearing.

The checked-in bundle has 1,657 mainline ways across all ten requested refs, 21 directed chains, and 415 exit attachments, of which 385 have a destination or name. Nine ways have no parseable `maxspeed` tag and retain a null limit. OSM speed tags are community data, not a current legal verification. Exit numbers are absent from this source, so the builder does not infer them. The source does not provide motorway_junction nodes, and ramps without a shared mainline node cannot be attached. The North–South Corridor is omitted because this extract does not establish an operational motorway ref for it.
