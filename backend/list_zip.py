import zipfile
import sys

try:
    zf = zipfile.ZipFile('/app/truedata_orderflow_export.zip')
    for x in zf.namelist():
        if 'normalized_ticks' in x:
            print(f"File inside container zip: {repr(x)}")
except Exception as exc:
    print(f"Error: {exc}")
