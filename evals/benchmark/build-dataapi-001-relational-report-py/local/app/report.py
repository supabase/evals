# Nightly sales report, run inside our Python backend worker:
#
#   uv run python report.py
#
# Connection settings come from the environment: SUPABASE_URL and
# SUPABASE_SECRET_KEY (this is trusted backend code).
#
# Print to stdout a JSON array with one entry per customer who has placed at
# least one order, sorted by customer name:
#
#   {
#     "customer": string,    // customer name
#     "orderCount": number,  // how many orders they placed
#     "totalCents": number,  // total spent across all their orders
#     "topProduct": string   // product they bought the most units of
#   }
#
# If two products tie on units, topProduct is the alphabetically first one.
#
# TODO: implement
import sys

print("not implemented", file=sys.stderr)
sys.exit(1)
