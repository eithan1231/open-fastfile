"""`image`: every image the zone holds pixels for, as `images/<name>.dds` (finest level only).

Where OpenAssetTools writes `.iwi`, this writes DDS, which scripts/cod/textures.py
reads by name just the same. Images named with a leading comma live in another
zone and are skipped here, as are formats `images.py` cannot size.
"""

import os
from collections import Counter

from .. import images
from . import dumper

FOLDER = "images"


@dumper("image")
def write(walked, out):
    found = walked.zone.found.get("IMAGE", {})
    written, skipped = images.export(walked.path, found, walked.zone.data, os.path.join(out, FOLDER))
    reasons = Counter(skipped.values())
    detail = "; ".join(f"{n} {reason}" for reason, n in reasons.most_common())
    print(f"      {written} of {len(found)} images written" + (f" (skipped: {detail})" if detail else ""))
