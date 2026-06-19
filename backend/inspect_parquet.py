import pyarrow.parquet as pq
import sys
from datetime import datetime

if len(sys.argv) < 2:
    print("Usage: python inspect_parquet.py <path_to_parquet>")
    sys.exit(1)

file_path = sys.argv[1]
try:
    table = pq.read_table(file_path)
    ts_col = table["timestamp"].to_pylist()
    min_ts = min(ts_col)
    max_ts = max(ts_col)
    print(f"File: {file_path}")
    print(f"Row count: {len(ts_col)}")
    print(f"Min TS: {min_ts} -> {datetime.fromtimestamp(min_ts/1000.0)}")
    print(f"Max TS: {max_ts} -> {datetime.fromtimestamp(max_ts/1000.0)}")
except Exception as exc:
    print(f"Error reading {file_path}: {exc}")
